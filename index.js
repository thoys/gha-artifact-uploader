require('chromedriver');
const {Builder, By, Key, until} = require('selenium-webdriver');

const chrome = require('selenium-webdriver/chrome');

const screen = {
    width: 640,
    height: 480
};

const express = require('express');
const crypto = require('crypto');
const Octokit = require("@octokit/rest");
const HttpStatus = require('http-status-codes');

require('dotenv').config();

const LISTENING_PORT = Number(process.env.LISTENING_PORT || 3000);
const ALLOWED_REPOS = process.env.ALLOWED_REPOS.split(";");
const CHECKSUM_ACTION_NAME = process.env.CHECKSUM_ACTION_NAME || "Get the output time";
const BUILD_UPLOAD_ALLOWED_LABEL = process.env.BUILD_UPLOAD_ALLOWED_LABEL || "allow-build-upload";

async function getChecksumFromCheckRun(githubCheckRunURL, checksumActionName) {
    let checksumStepText = "";

    let chromeOptions = new chrome.Options();
    chromeOptions.headless();
    chromeOptions.windowSize(screen);
    chromeOptions.addArguments("--no-sandbox");
    chromeOptions.addArguments("--disable-dev-shm-usage");

    let driver = new Builder().forBrowser('chrome')
        .setChromeOptions(chromeOptions)
        .build();

    try {
        await driver.get(githubCheckRunURL);
        let checksumStepLabel = await driver.findElement(By.xpath("//*[text()='" + checksumActionName + "']"));
        let checksumStep = await checksumStepLabel.findElement(By.xpath("./../.."));

        await checksumStep.click();
        await driver.wait(until.elementLocated(By.className('js-checks-log-group')), 10000);

        let logClass = await checksumStep.findElement(By.className('js-checks-log-group'));
        await logClass.click();

        await checksumStep.getText().then((text) => {
            checksumStepText = text;
        });
        console.log(checksumStepText);
    } finally {
        await driver.quit();
    }
    return checksumStepText;
}


const app = express();

const octokit = Octokit({
    auth: process.env.GH_AUTH_TOKEN
});

var concat = require('concat-stream');
app.use(function (req, res, next) {
    const {owner, repo, check_run_id} = req.headers;
    if (!owner || !repo || !check_run_id) {
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).send('One of the required headers is not set correctly.');
        return;
    }
    if (!ALLOWED_REPOS.includes(`${owner}/${repo}`)) {
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).send('Selected repo is not permitted to use this service.');
        return;
    }
    req.pipe(concat(function (data) {
        req.body = data;
        next();
    }));
});

function isPRBuildAllowedToBeUploaded(pull_request_data) {
    return pull_request_data.author_association === "OWNER" ||
        pull_request_data.author_association === "MEMBER" ||
        pull_request_data.labels.some(label => label.name === BUILD_UPLOAD_ALLOWED_LABEL);
}

app.listen(LISTENING_PORT, () => console.log(`App listening on port ${LISTENING_PORT}!`));

app.put('/', function (req, res) {
    const fileHash = crypto.createHash('sha256').update(req.body).digest('hex');
    console.log(fileHash);
    const {owner, repo, check_run_id} = req.headers;
    octokit.checks.get({owner, repo, check_run_id}).then(({data}) => {

        console.log(data);

        getChecksumFromCheckRun(data.html_url, CHECKSUM_ACTION_NAME).then(function (checksumText) {
            console.log("Checksum text = " + checksumText);
            if (data.pull_requests.length === 0) {
                res.status(HttpStatus.INTERNAL_SERVER_ERROR).send('No pull requests connected to check-run.');
                return;
            }

            if (data.pull_requests.length > 1) {
                res.status(HttpStatus.INTERNAL_SERVER_ERROR).send('Too many pull requests connected to check-run.');
                return;
            }

            octokit.pulls.get({owner, repo, pull_number: data.pull_requests[0].number}).then(({data}) => {
                if (!isPRBuildAllowedToBeUploaded(data)) {
                    res.status(HttpStatus.INTERNAL_SERVER_ERROR)
                        .send(`Please label PR build next time with the ${BUILD_UPLOAD_ALLOWED_LABEL} label.`);
                    return;
                }
                console.log(data);
                res.send({test: 2});
            });
        });
    }).catch((err) => {
        console.log("err = " + err);
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).send('Error happened please check server logs.');
    });
});
