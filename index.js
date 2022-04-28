'use strict';

const core = require('@actions/core'),
    github = require('@actions/github'),
    twitter = require('twitter-text'),
    { TwitterApi } = require('twitter-api-v2'),
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
    const { data: column } = await octokit.rest.projects.getColumn({ column_id: github.context.payload.project_card.column_id });
    if(issue.state === "open" && column.name === core.getInput('column')) {
        const cardContent = JSON.parse(core.getInput('cardContent'));

        if(cardContent.date?.valid) {
            //TODO handle scheduled tweet - maybe via some action middleware that schedules another workflow?
            core.info('Ignoring scheduled tweets for now.');
            return;
        }
        const twitterClient = new TwitterApi({
            appKey: core.getInput('twitterApiKey'),
            appSecret: core.getInput('twitterApiSecret'),
            accessToken: core.getInput('twitterAccessToken'),
            accessSecret: core.getInput('twitterAccessSecret'),
        });
        const { data: userInfo } = await twitterClient.v2.me();
        const content = cardContent[core.getInput('tweetContent')];
        const retweetUrl = cardContent[core.getInput('retweetHeading')];
        let resultMessage;
        if(retweetUrl && !content) {
            const retweetId = getTweetIdFromUrl(retweetUrl);
            await twitterClient.v2.retweet(userInfo.id, retweetId);
            resultMessage = 'Successfully retweeted.';
        }
        else {
            const [ tweet, media ] = getMediaAndContent(content);
            const parsedTweet = twitter.parseTweet(tweet);
            if(parsedTweet.weightedLength > MAX_WEIGHTED_LENGTH) {
                throw new Error(`Tweet content too long by ${parsedTweet.weightedLength - MAX_WEIGHTED_LENGTH} weighted characters.`);
            }

            if (media.length > 0) {
                throw new Error('Media is not supported yet. Please remove the image from the tweet content.');
            }

            const args = {};
            const replyToUrl = cardContent[core.getInput('replyToHeading')];
            const replyToId = getTweetIdFromUrl(replyToUrl);
            if(replyToId) {
                args.reply = { in_reply_to_tweet_id: replyToId };
            }
            if(retweetUrl) {
                args.attachment_url = retweetUrl;
            }
            const { data: tweetInfo } = await twitterClient.v2.tweet(tweet, args);
            resultMessage = `Successfully tweeted: https://twitter.com/${userInfo.username}/status/${tweetInfo.id}`;
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

doStuff().catch((error) => {
    console.error(error);
    core.setFailed(error.message);
});
