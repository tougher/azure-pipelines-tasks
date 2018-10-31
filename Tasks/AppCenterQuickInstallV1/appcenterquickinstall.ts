import path = require('path');
import tl = require('vsts-task-lib/task');
import request = require('request');
import Q = require('q');
import os = require('os');
import qr = require('qrcode');
import st = require('stream');
import git = require("vso-node-api/interfaces/GitInterfaces");
import base64url = require('base64url');
import uuid = require('uuid/v4');
//import * as azdev from "vso-node-api";

const API_VERSION: string = "4.1-preview";

interface ReleaseData {
    app_os: string;
    app_display_name: string;
    version: string;
    short_version: string;
    install_url: string;
}

function responseHandler(defer, err, res, body, handler: () => void) {
    if (body) {
        tl.debug(`---- ${JSON.stringify(body)}`);
    }

    if (err) {
        tl.debug(`---- Failed with error: ${err}`);
        defer.reject(err);
        return;
    }

    if (!res) {
        defer.reject(tl.loc("NoResponseFromServer"));
        return;
    }

    tl.debug(`---- http call status code: ${res.statusCode}`);
    if (res.statusCode < 200 || res.statusCode >= 300) {
        let message = JSON.stringify(body);
        if (!message) {
            message = `http response code: ${res.statusCode}`;
        } else {
            message = message.concat(os.EOL + `http response code: ${res.statusCode}`);
        }
        defer.reject(message);
        return;
    }

    handler();
}


function getPullRequestUrl(sourceRepositoryUrl: string, pullRequestId: string, token: string, userAgent: string): Q.Promise<string> {
    tl.debug("-- Get pull request.");
    let defer = Q.defer<string>();
    let url: string = `${sourceRepositoryUrl}/pullrequests/${pullRequestId}?api-version=${API_VERSION}`;
    tl.debug(`---- url: ${url}`);

    let headers = {
        "Authorization": token,
        "User-Agent": userAgent,
        "internal-request-source": "VSTS",
        "Content-Type": "application/json"
    };

    request.get({ url: url, headers: headers }, (err, res, body) => {
        responseHandler(defer, err, res, body, () => {
            tl.debug("pull request raw response body: " + body);
            let pr = JSON.parse(body);
            defer.resolve(pr['url']);
        });
    });

    return defer.promise;
}

function parseReleases(releaseData0: string, releaseData1: string, releaseData2: string, releaseData3: string) : ReleaseData[] {
    let releases: ReleaseData[] = [];

    if (releaseData0 != null && releaseData0 !== ""){
        releases.push(JSON.parse(releaseData0));
    }
    
        if (releaseData1 != null && releaseData1 !== ""){
            releases.push(JSON.parse(releaseData1));
        }

        if (releaseData2 != null && releaseData2 !== ""){
            releases.push(JSON.parse(releaseData2));
        }

        if (releaseData3 != null && releaseData3 !== ""){
            releases.push(JSON.parse(releaseData3));
        }
    
    return releases;
}

function makeAndUploadQrCode(pullRequestUrl: string, token: string, userAgent: string, inputText: string) : Q.Promise<string> {
    let defer = Q.defer<string>();

    tl.debug("-- Generate QR code from input: " + inputText);
    /*
    let stream = new st.Duplex;
    stream.writable = true;
    stream.readable = true;
    qr.toFileStream(stream, inputText);
    */
    
    qr.toDataURL(inputText).then(qrCodeBase64Url => {
        tl.debug("-- qr code base64 url: " + qrCodeBase64Url);
        let buffer = base64url.toBuffer(qrCodeBase64Url.replace("data:image/png;base64,", ""));
        tl.debug("-- Upload QR code as attachment to the pull request.");

        let url: string = `${pullRequestUrl}/attachments/qr-${uuid()}.png?api-version=${API_VERSION}`;
        tl.debug(`---- url: ${url}`);

        let headers = {
            "Authorization": token,
            "User-Agent": userAgent,
            "internal-request-source": "VSTS",
            "Content-Type": "application/octet-stream"
        };

        request.post({ url: url, headers: headers, body: buffer/*, encoding: null*/ }, (err, res, body) => {
            responseHandler(defer, err, res, body, () => {
                tl.debug("qr code attachments raw response body: " + body);
                let parsed = JSON.parse(body);
                defer.resolve(parsed['url']);
            });
        });
    });
    
    return defer.promise;
}

async function addThreadComment(pullRequestUrl: string, token: string, userAgent: string, releases: ReleaseData[]){
    let defer = Q.defer<void>();
    
    let commentBody = "#Quick Install Links\n";
    let commentBodyHeader = "|";
    let commentBodyAlignment = "|";
    let commentBodyContent = "|";
    
    for(let key in releases){
        let release = releases[key];
        tl.debug("-- Generating QR code with input: " + release.install_url);
        let qrCodeUrl = await makeAndUploadQrCode(pullRequestUrl, token, userAgent, release.install_url);

        commentBodyHeader += " [" + release.app_os + "](release.install_url) |";
        commentBodyAlignment += "-----------|";
        commentBodyContent += " ![qr-code](" + qrCodeUrl + ") |";
    }

    commentBody += commentBodyHeader + "\n" + commentBodyAlignment + "\n" + commentBodyContent;

    tl.debug("-- Adding pull request thread comment.");

    let url: string = `${pullRequestUrl}/threads?api-version=${API_VERSION}`;
    tl.debug(`---- url: ${url}`);

    let headers = {
        "Authorization": token,
        "User-Agent": userAgent,
        "internal-request-source": "VSTS"
    };
    
    let publishBody = {
        "comments": [
            {
                "parentCommentId": 0,
                "content": commentBody,
                "commentType": "system"
            }
        ],
        "properties": {
            "Microsoft.TeamFoundation.Discussion.SupportsMarkdown": {
                "type": "System.Int32",
                "value": 1
            }
        },
        "status": "closed"
    };

    request.post({ url: url, headers: headers, json: publishBody }, (err, res, body) => {
        responseHandler(defer, err, res, body, () => {
            defer.resolve();
        });
    });

    return defer.promise;
}

async function run() {
    try {
        tl.setResourcePath(path.join(__dirname, 'task.json'));

        // Get build inputs
        //let sourceRepositoryUrl = tl.getInput('sourceRepository', true);
        let sourceRepositoryUrl = tl.getVariable('system.pullrequest.sourcerepositoryuri');
        //let pullRequestId = tl.getInput('pullRequestId', true);
        let pullRequestId = tl.getVariable('system.pullrequest.pullrequestid');
        //let apiAccessToken = tl.getInput('apiAccessToken', true);
        let bearerToken = tl.getVariable('system.accessToken');
        let orgUrl = tl.getVariable('system.teamfoundationcollectionuri');
        
        if (sourceRepositoryUrl == null || sourceRepositoryUrl === "") throw Error ('system.pullrequest.sourcerepositoryuri not set');
        if (pullRequestId == null || pullRequestId === "") throw Error ('system.pullrequest.pullrequestid not set');
        if (bearerToken == null || bearerToken === "") throw Error ('system.accessToken not set');
        
        tl.debug(`system.pullrequest.sourcerepositoryuri = ${sourceRepositoryUrl}`);
        tl.debug(`system.pullrequest.pullrequestid = ${pullRequestId}`);
        tl.debug(`system.accessToken = ${bearerToken.substring(0, 3)}...`);

        /*
        // TODO: implement this
        let authHandler = azdev.getBearerHandler(bearerToken);

        let connection = new azdev.WebApi(orgUrl, authHandler);
        connection.getGitApi()
        */

        bearerToken = "Bearer " + bearerToken;
        
        // "Patching" source repos url to an API url
        sourceRepositoryUrl = sourceRepositoryUrl.replace("_git", "_apis/git/repositories");
        tl.debug("sourceRepositoryUrl patched to: " + sourceRepositoryUrl);
        
        let releaseData0 = tl.getInput('releaseData0', true);
        let releaseData1 = tl.getInput('releaseData1', false);
        let releaseData2 = tl.getInput('releaseData2', false);
        let releaseData3 = tl.getInput('releaseData3', false);

        let releases = parseReleases(releaseData0, releaseData1, releaseData2, releaseData3);
        
        let userAgent = tl.getVariable('MSDEPLOY_HTTP_USER_AGENT');
        if (!userAgent) {
            userAgent = 'VSTS';
        }
        userAgent = userAgent + ' (Task:VSMobileCenterUpload)';
        
        let pullRequestUrl = await getPullRequestUrl(sourceRepositoryUrl, pullRequestId, bearerToken, userAgent);
        
        if (pullRequestUrl == null || pullRequestUrl === "") throw Error ('pull request url invalid: ' + pullRequestUrl);

        await addThreadComment(pullRequestUrl, bearerToken, userAgent, releases);

        tl.setResult(tl.TaskResult.Succeeded, tl.loc("Succeeded"));
    } catch (err) {
        tl.setResult(tl.TaskResult.Failed, `${err}`);
    }
}

run();
