require('chromedriver');
const {Builder, By, Key, until} = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const Sentry = require('@sentry/node');
const sleep = require('sleep');
const express = require('express');
const crypto = require('crypto');
const Octokit = require("@octokit/rest");
const HttpStatus = require('http-status-codes');
const concat = require('concat-stream');
const YAML = require('yaml');
const fs = require('fs');
const path = require('path');

let config = null;
try {
    const configFileContents = fs.readFileSync('./config.yml', 'utf8');
    config = YAML.parse(configFileContents);
} catch (e) {
    console.error('Failed to load config.yml be sure exists otherwise copy config.yml.example and modify it to your needs.');
    return;
}

const screen = {
    width: 640,
    height: 480
};

require('dotenv').config();

const LISTENING_PORT = Number(process.env.LISTENING_PORT || 3000);
const ALLOWED_REPOS = Object.keys(config.repositories); //process.env.ALLOWED_REPOS.split(";");
const CHECKSUM_ACTION_NAME = process.env.CHECKSUM_ACTION_NAME || "Hash artifacts";
const BUILD_UPLOAD_ALLOWED_LABEL = process.env.BUILD_UPLOAD_ALLOWED_LABEL || "allow-build-upload";
const BUILD_FILE_HASHES_REGEX = "BuildFileHashes: (\\[(.+)\\])";

Sentry.init({ dsn: config.sentry_dsn });

let isSeleniumBusy = false;

async function getChecksumFromCheckRun(githubCheckRunURL, checksumActionName) {
    let checksumStepText = "";

    while (isSeleniumBusy) {
        // waiting for selenium to be done.
        sleep.msleep(50);
    }
    isSeleniumBusy = true;

    let chromeOptions = new chrome.Options();
    chromeOptions.headless();
    chromeOptions.windowSize(screen);
    chromeOptions.addArguments("--no-sandbox");
    chromeOptions.addArguments("--disable-dev-shm-usage");
    let driver;
    try {
        driver = new Builder().forBrowser('chrome')
            .setChromeOptions(chromeOptions)
            .build();

        await driver.get(githubCheckRunURL);
        let checksumStepLabel = await driver.findElement(By.xpath("//*[text()='" + checksumActionName + "']"));
        let checksumStep = await checksumStepLabel.findElement(By.xpath("./../.."));

        await checksumStep.click();
        let startCheckingForLogMS = Date.now();
        await driver.wait(until.elementLocated(By.className('js-checks-log-group')), 10000);
        console.log("It took " + (Date.now() - startCheckingForLogMS) + "ms to wait for the element to load.");

        let logClass = await checksumStep.findElement(By.className('js-checks-log-group'));
        await logClass.click();

        await checksumStep.getText().then((text) => {
            checksumStepText = text;
        });
        console.log(checksumStepText);
    } catch (e) {
        Sentry.captureException(e);
    } finally {
        if (driver) {
            await driver.quit();
        }
        isSeleniumBusy = false;
    }
    return checksumStepText;
}

const app = express();

const octokit = Octokit({
    auth: config.github_auth_token
});


app.use(async (request, response, next) => {
    const {owner, repo, commit_hash, pull_number, job_name} = request.headers;
    if (!owner || !repo || !commit_hash || !pull_number || !job_name) {
        response.status(HttpStatus.INTERNAL_SERVER_ERROR).send('One of the required headers is not set correctly.');
        return;
    }
    if (!ALLOWED_REPOS.includes(`${owner}/${repo}`)) {
        response.status(HttpStatus.INTERNAL_SERVER_ERROR).send('Selected repo is not permitted to use this service.');
        return;
    }
    let pull_data = (await octokit.pulls.get({owner, repo, pull_number})).data;
    if (!isPRBuildAllowedToBeUploaded(pull_data)) {
        response.status(HttpStatus.INTERNAL_SERVER_ERROR)
            .send(`Please label PR build next time with the ${BUILD_UPLOAD_ALLOWED_LABEL} label.`);
        return;
    }
    let pull_commits = (await octokit.pulls.listCommits({owner, repo, pull_number, per_page: 100})).data;
    if (!pull_commits.some(commit => commit.sha === commit_hash)) {
        response.status(HttpStatus.INTERNAL_SERVER_ERROR)
            .send(`Pull request does not contains commit sha: ${commit_hash}.`);
        return;
    }

    request.pipe(concat(function (data) {
        request.body = data;
        next();
    }));
});

function isPRBuildAllowedToBeUploaded(pull_request_data) {
    return pull_request_data.author_association === "OWNER" ||
        pull_request_data.author_association === "MEMBER" ||
        pull_request_data.author_association === "COLLABORATOR" ||
        pull_request_data.labels.some(label => label.name === BUILD_UPLOAD_ALLOWED_LABEL);
}

async function asyncSome(array, callback) {
    for (let index = 0; index < array.length; index++) {
        if (await callback(array[index], index, array)) {
            return true;
        }
    }
    return false;
}

function getStoragePath(path, variables) {
    return path.replace(/\[\:([a-zA-Z0-9_]+)\]/g, (match, variable_key) => {
        if (variables[variable_key] === undefined) {
            console.error(`Could not find ${variable_key} for path: ${path}.`);
            return '';
        }
        return variables[variable_key];
    });
}

app.listen(LISTENING_PORT, () => console.log(`App listening on port ${LISTENING_PORT}!`));

app.put('/', async function (request, response) {
    try {
        const fileHash = crypto.createHash('sha256').update(request.body).digest('hex');
        console.log(fileHash);
        const {owner, repo, commit_hash, pull_number, job_name} = request.headers;
        const repositoryConfig = config.repositories[`${owner}/${repo}`];
        let check_run_data = (await octokit.checks.listForRef({
            owner,
            repo,
            ref: commit_hash,
            check_name: job_name
        })).data;

        console.log(check_run_data);

        (async function() {
            let targetFilename = null;
            let checksumMatch = await asyncSome(check_run_data.check_runs, async (check_run) => {
                let checksumText = await getChecksumFromCheckRun(check_run.html_url, CHECKSUM_ACTION_NAME);
                console.log('check_run name = ' + check_run.name + ' text: ' + checksumText);
                let regExp = new RegExp(BUILD_FILE_HASHES_REGEX, 'gm');
                let match = regExp.exec(checksumText);
                if (!match) {
                    console.log(`check_run ${check_run.name} doesn't have build file hashes.`);
                    response.status(HttpStatus.INTERNAL_SERVER_ERROR).send('Received file checksum does not match any found checksum.');
                    return false;
                }
                let buildFileHashes;
                try {
                    buildFileHashes = JSON.parse(match[1]);
                } catch (e) {
                    console.log(`failed to parse build hashes.`);
                    Sentry.captureException(e);
                    response.status(HttpStatus.INTERNAL_SERVER_ERROR).send('Failed to parse build hashes. Could be an invalid JSON object.');
                    return false;
                }

                console.log('buildFileHashes: ' + JSON.stringify(buildFileHashes));

                console.log(`Looking for the filename of artifact with the hash ${fileHash}.`);

                let buildFileHashPair = buildFileHashes.find((buildFileHash) => {
                    return buildFileHash.sha256_checksum === fileHash;
                });

                if (!buildFileHashPair) {
                    console.log(`Failed to find build hash in JSON object.`);
                    response.status(HttpStatus.INTERNAL_SERVER_ERROR).send('Failed to find build hash in JSON object.');
                    return false;
                }

                targetFilename = buildFileHashPair.filename;

                console.log(`Found ${targetFilename} with selected hash ${fileHash}.`);
/*
                fs.writeFile(fileHash, request.body, function (err) {
                    if (err) throw err;
                    console.log('Saved ' + fileHash + '!');
                });
*/
                return true;
            });

            if (!checksumMatch) {
                response.status(HttpStatus.INTERNAL_SERVER_ERROR).send('Received file checksum does not match any found checksum.');
                return;
            }

            // Storage

            let file_name = targetFilename;
            let file_extname = path.extname(file_name);
            let file_basename = path.basename(file_name, file_extname);

            const repositoryStorages = repositoryConfig.storages;
            let publishUrls = [];
            repositoryStorages.forEach((repositoryStorage) => {
                const storage = config.storages[repositoryStorage.storage];
                const storagePath = getStoragePath(storage.path, {
                    owner,
                    repo,
                    pull_number,
                    file_name,
                    file_basename,
                    file_extname,
                    commit_short_hash: commit_hash
                });

                if (storage.method === 'file') {
                    fs.writeFile(storagePath, request.body, function (err) {
                        if (err) throw err;
                        console.log('Saved ' + fileHash + '!');
                    });
                    if (repositoryStorage.publish_url) {
                        publishUrls.push(storagePath);
                    }
                } else if (storage.method === 'S3') {

                }

                console.log(storagePath);
            });

            console.log('done');
            response.send({
                success: true
            });
        }());
    } catch (err) {
        console.log("err = " + err);
        Sentry.captureException(err);
        response.status(HttpStatus.INTERNAL_SERVER_ERROR).send('Error happened please check server logs.');
    }
});
