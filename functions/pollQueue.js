"use strict";

const AWS = require("aws-sdk");
const DBD = new AWS.DynamoDB.DocumentClient();
const SQS = new AWS.SQS({ apiVersion: "2012-11-05" });
const Lambda = new AWS.Lambda({ apiVersion: "2015-03-31" });
const Metrics = require("../lib/metrics");

// Running list of timestamps for hits on rate limit
let rateHits;
// Last time heartbeat metrics were sent, for throttling
let lastHeartbeat;

module.exports.handler = async function(event, context) {
  const constants = require("../lib/constants");
  const { POLL_DELAY } = constants;

  rateHits = [];
  lastHeartbeat = false;

  try {
    await acquireExecutionLock(process.env, constants);
  } catch (err) {
    console.warn("Could not acquire execution mutex", err);
    return;
  }
  console.info("Execution mutex acquired");

  try {
    await sendHeartbeatMetrics(process.env, context);
  } catch (err) {
    console.warn("Failed to send initial heartbeat metrics", err);
  }

  let polls = 0;
  console.info("Poller start");
  while (Math.floor(context.getRemainingTimeInMillis() / 1000) >= 1) {
    try {
      const tname = `pollQueue ${++polls}`;
      console.time(tname);
      await pollQueue(process.env, constants, context);
      console.timeEnd(tname);
    } catch (err) {
      console.error("Error in pollQueue", err);
      return;
    }

    try {
      await maybeSendHeartbeatMetrics(process.env, constants, context);
    } catch (err) {
      console.warn("Failed to send periodic heartbeat metrics", err);
    }

    console.info("Pausing for", POLL_DELAY, "ms");
    await wait(POLL_DELAY);
    console.info("Remaining", context.getRemainingTimeInMillis(), "ms");
  }
  console.info("Poller exit");

  try {
    await releaseExecutionLock(process.env, constants);
  } catch (err) {
    console.warn("Could not release execution mutex", err);
    return;
  }
  console.info("Execution mutex released");

  try {
    await sendHeartbeatMetrics(process.env, context);
  } catch (err) {
    console.warn("Failed to send final heartbeat metrics", err);
  }
};

const wait = delay => new Promise(resolve => setTimeout(resolve, delay));

const acquireExecutionLock = (
  { CONFIG_TABLE },
  { EXECUTION_MUTEX_KEY, EXECUTION_MUTEX_TTL }
) =>
  DBD.put({
    TableName: CONFIG_TABLE,
    Item: {
      key: EXECUTION_MUTEX_KEY,
      value: Date.now() + EXECUTION_MUTEX_TTL
    },
    ConditionExpression: "#key <> :key OR (#key = :key AND #value < :value)",
    ExpressionAttributeNames: { "#key": "key", "#value": "value" },
    ExpressionAttributeValues: {
      ":key": EXECUTION_MUTEX_KEY,
      ":value": Date.now()
    }
  }).promise();

const releaseExecutionLock = (
  { CONFIG_TABLE },
  { EXECUTION_MUTEX_KEY, EXECUTION_MUTEX_TTL }
) =>
  DBD.delete({
    TableName: CONFIG_TABLE,
    Key: { key: EXECUTION_MUTEX_KEY }
  }).promise();

// Throttle sending heartbeat metrics
const maybeSendHeartbeatMetrics = async (env, constants, context) => {
  if (
    lastHeartbeat !== false &&
    Date.now() - lastHeartbeat < constants.MIN_HEARTBEAT_PERIOD
  ) {
    console.info("Skipping heartbeat metrics ping", Date.now() - lastHeartbeat);
    return;
  }
  await sendHeartbeatMetrics(env, context);
};

const sendHeartbeatMetrics = async (
  { QUEUE_NAME },
  { awsRequestId: poller_id }
) => {
  console.info("Sending heartbeat metrics");
  lastHeartbeat = Date.now();
  const { QueueUrl } = await SQS.getQueueUrl({
    QueueName: QUEUE_NAME
  }).promise();
  const {
    ApproximateNumberOfMessages: items_in_queue,
    ApproximateNumberOfMessagesDelayed: items_in_waiting,
    ApproximateNumberOfMessagesNotVisible: items_in_progress
  } = await SQS.getQueueAttributes({
    QueueUrl,
    AttributeNames: [
      "ApproximateNumberOfMessages",
      "ApproximateNumberOfMessagesDelayed",
      "ApproximateNumberOfMessagesNotVisible"
    ]
  }).promise();
  await Metrics.pollerHeartbeat({
    poller_id,
    items_in_queue,
    items_in_progress,
    items_in_waiting
  });
};

async function pollQueue(
  { QUEUE_NAME, PROCESS_QUEUE_FUNCTION },
  { MAX_LONG_POLL_PERIOD, RATE_PERIOD, RATE_LIMIT },
  context
) {
  // Calculate seconds remaining for poller execution, using maximum for
  // long poll or whatever time we have left
  const WaitTimeSeconds = Math.min(
    MAX_LONG_POLL_PERIOD,
    Math.floor(context.getRemainingTimeInMillis() / 1000)
  );
  if (WaitTimeSeconds <= 0) {
    console.log("Out of time");
    return;
  }

  // Slide the rate limit window and calculate available hits
  const rateWindowStart = Date.now() - RATE_PERIOD;
  rateHits = rateHits.filter(item => item > rateWindowStart);
  const MaxNumberOfMessages = RATE_LIMIT - rateHits.length;
  if (MaxNumberOfMessages <= 0) {
    console.log("Yielding to limit rate");
    return;
  }

  // Long-poll for SQS messages up to rate limit or execution timeout
  console.time("SQS");
  const { QueueUrl } = await SQS.getQueueUrl({
    QueueName: QUEUE_NAME
  }).promise();
  const receiveResult = await SQS.receiveMessage({
    QueueUrl,
    WaitTimeSeconds,
    MaxNumberOfMessages,
    MessageAttributeNames: ["All"]
  }).promise();
  console.timeEnd("SQS");

  // Process the messages received from queue
  const messages = receiveResult.Messages || [];
  if (messages.length > 0) {
    // Invoke the workers in parallel, since we're only ever going
    // to invoke up to the rate limit
    console.time("Worker batch");
    await Promise.all(
      messages.map(async message => {
        const messageBody = JSON.parse(message.Body);

        const mtname = `Message ${messageBody.requestId}`;
        console.time(mtname);

        // Record a hit for rate limit
        rateHits.push(Date.now());

        // Invoke the process function for queue item
        await Lambda.invoke({
          FunctionName: PROCESS_QUEUE_FUNCTION,
          InvocationType: "Event",
          LogType: "None",
          Payload: JSON.stringify(message)
        }).promise();

        console.timeEnd(mtname);
      })
    );
    console.timeEnd("Worker batch");
  }
}
