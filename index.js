'use strict';

const core = require('@actions/core'),
    github = require('@actions/github'),
    twitter = require('twitter-text'),
    Twitter = require('twitter'),
    fetch = require('fetch-base64'),
    token = core.getInput('token'),
    octokit = github.getOctokit(token),
    MAX_WEIGHTED_LENGTH = 280;

if(!/\/(?:issue|pull-request)s\/(\d+)$/.test(github.context.payload.project_card?.content_url)) {
    core.info('Not running on an event with an associated card.');
    return;
}

async function getIssue() {
    const issueNumber = /\/(?:issue|pull-request)s\/(\d+)$/.exec(github.context.payload.project_card.content_url);
    const { data: result } = await octokit.rest.issues.get({
        ...github.context.repo,
        issue_number: issueNumber[1],
    });
    return result;
}

function getMediaAndContent(tweet) {
    if(tweet.search(/!\[[^\]]*\]\([^)]+\)/) !== -1) {
        const media = [];
        const pureTweet = tweet.replace(/!\[[^\]]*\]\(([^)]+)\)/g, (match, url) => {
            media.push(url);
            return '';
        });
        if(media.length > 4) {
            throw new Error("Can not upload more than 4 images per tweet");
        }
        return [ pureTweet.trim(), media ];
    }
    return [ tweet.trim(), [] ];
}

function getTweetIdFromUrl(url) {
    const match = /^https?:\/\/(?:www\.)?twitter.com\/[^/]+\/status\/([0-9]+)\/?$/.exec(url);
    return match?.[1] ?? null;
}

async function doStuff() {
    const issue = await getIssue();
    const { data: column } = await ocotokit.projects.getColumn({ column_id: github.context.payload.project_card.column_id });
    if(issue.state === "open" && column.name === core.getInput('column')) {
        const cardContent = JSON.parse(core.getInput('cardContent'));

        if(cardContent.date?.valid) {
            //TODO handle scheduled tweet - maybe via some action middleware that schedules another workflow?
            core.info('Ignoring scheduled tweets for now.');
            return;
        }
        const twitterClient = new Twitter({
            consumer_key: core.getInput('twitterConsumerKey'),
            consumer_secret: core.getInput('twitterConsumerSecret'),
            access_token_key: core.getInput('twitterAccessTokenKey'),
            access_token_secret: core.getInput('twitterAccessTokenSecret'),
        });
        const verifyResult = await twitterClient.get('account/verify_credentials', {});
        const content = cardContent[core.getInput('tweetContent')];
        const retweetUrl = cardContent[core.getInput('retweetHeading')];
        let resultMessage;
        if(retweetUrl && !content) {
            const retweetId = getTweetIdFromUrl(retweetUrl);
            await twitterClient.post(`statuses/retweet/${retweetId}`, {});
            resultMessage = 'Successfully retweeted.';
        }
        else {
            const [ tweet, media ] = getMediaAndContent(content);
            const parsedTweet = twitter.parseTweet(tweet);
            if(parsedTweet.weightedLength > MAX_WEIGHTED_LENGTH) {
                throw new Error(`Tweet content too long by ${parsedTweet.weightedLength - MAX_WEIGHTED_LENGTH} weighted characters.`);
            }

            const uploadedMedia = await Promise.all(media.map(async (url) => {
                const [ media_data ] = await fetch.remote(url);
                const args = {
                    media_data,
                };
                const response = await twitterClient.post('media/upload', args);
                return response.media_id_string;
            }));
            const args = {
                status: tweet,
            };
            const replyToUrl = cardContent[core.getInput('replyToHeading')];
            const replyToId = getTweetIdFromUrl(replyToUrl);
            if(replyToId) {
                args.in_reply_to_status_id = replyToId;
                const user = /^https?:\/\/(?:www\.)?twitter.com\/([^/]+)\/status\/[0-9]+\/?$/.exec(replyToUrl);
                const mentions = twitter.extractMentions(tweet).map((mention) => mention.toLowerCase());
                if(!mentions.length || !mentions.includes(user[1].toLowerCase())) {
                    args.auto_populate_reply_metadata = "true";
                }
            }
            if(retweetUrl) {
                args.attachment_url = retweetUrl;
            }
            if(uploadedMedia.length) {
                args.media_ids = uploadedMedia;
            }
            const tweetInfo = await twitterClient.post('statuses/update', args);
            resultMessage = `Successfully tweeted: https://twitter.com/${verifyResult.screen_name}/status/${tweetInfo.id_str}`;
        }
        await octokit.rest.issues.createComment({
            ...github.context.repo,
            issue_number: issue.number,
            body: resultMessage,
        });
        await octokit.rest.issues.update({
            ...github.context.repo,
            issue_number: issue.number,
            state: 'closed',
        });
    }
}

doStuff().catch((error) => core.setFailed(error.message));
