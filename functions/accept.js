"use strict";

const Hawk = require("hawk");
const Busboy = require("busboy");
const AWS = require("aws-sdk");
const S3 = new AWS.S3({ apiVersion: "2006-03-01" });
const SQS = new AWS.SQS({ apiVersion: "2012-11-05" });
const documentClient = new AWS.DynamoDB.DocumentClient();
const { DEV_CREDENTIALS, DEFAULT_HAWK_ALGORITHM } = require("../lib/constants");
const Sentry = require("../lib/sentry");
const Metrics = require("../lib/metrics");
const { md5 } = require("../lib/utils.js");

const REQUIRED_FIELDS = ["image", "negative_uri", "positive_uri"];

const Raven = Sentry();

module.exports.post = async function(event, context) {
  const log = require("../lib/logging")({
    name: "accept",
    isRequest: true,
    event,
    context,
  });

  const {
    UPSTREAM_SERVICE_URL,
    QUEUE_NAME: QueueName,
    CONTENT_BUCKET: Bucket,
  } = process.env;

  log.verbose("env", {
    UPSTREAM_SERVICE_URL,
    QueueName,
    Bucket,
  });

  const {
    headers,
    queryStringParameters: params,
    requestContext: { path, requestId },
  } = event;

  log.verbose("event", { headers, params, path, requestId });

  const {
    Host: host,
    Authorization: authorization,
    "X-Forwarded-Port": port = 80,
  } = headers;

  let authArtifacts;
  try {
    ({ artifacts: authArtifacts } = await Hawk.server.authenticate(
      {
        method: "POST",
        url: path,
        params,
        host,
        port,
        authorization,
      },
      lookupCredentials
    ));
    log.commonFields.uid = authArtifacts.id;
  } catch (err) {
    Raven.captureException(err);
    log.error("authInvalid", { authorization, error: err.message });
    return response(
      401,
      { error: err.message },
      { "WWW-Authenticate": "Hawk" }
    );
  }

  let body, negative_uri, positive_uri, positive_email, notes, image;
  try {
    body = await parseRequestBody(event);
    REQUIRED_FIELDS.forEach(name => {
      if (!body[name]) {
        log.warn("requestInvalid", { field: name });
        throw { message: `Required "${name}" is missing` };
      }
    });
    // TODO: More input validation here?
    ({ negative_uri, positive_uri, positive_email, notes, image } = body);

    log.debug("body", {
      negative_uri,
      positive_uri,
      positive_email,
      notes,
      image: {
        filename: image.filename,
        contentEncoding: image.contentEncoding,
        contentType: image.contentType,
        dataMD5: md5(image.data || ""),
      },
    });
  } catch (err) {
    Raven.captureException(err);
    return response(400, { error: err.message });
  }

  const imageKey = `image-${requestId}`;

  const upstreamServiceUrl =
    UPSTREAM_SERVICE_URL !== "__MOCK__"
      ? UPSTREAM_SERVICE_URL
      : "https://" +
        event.headers.Host +
        "/" +
        event.requestContext.stage +
        "/mock/upstream";

  const messageData = {
    datestamp: new Date().toISOString(),
    upstreamServiceUrl,
    id: requestId,
    user: authArtifacts.id,
    negative_uri,
    positive_uri,
    positive_email,
    notes,
    image: imageKey,
  };
  log.verbose("enqueue", messageData);

  const MessageBody = JSON.stringify(messageData);

  const imagePutResult = await S3.putObject({
    Bucket,
    Key: imageKey,
    ContentType: image.contentType,
    Body: image.data,
  }).promise();

  log.verbose("imagePutResult", { imagePutResult });

  const requestPutResult = await S3.putObject({
    Bucket,
    Key: `${imageKey}-request.json`,
    ContentType: "application/json",
    Body: MessageBody,
  }).promise();

  log.verbose("requestPutResult", { requestPutResult });

  const { QueueUrl } = await SQS.getQueueUrl({ QueueName }).promise();
  const queueSendResult = await SQS.sendMessage({
    QueueUrl,
    MessageBody,
  }).promise();

  log.verbose("queueSendResult", { QueueUrl, queueSendResult });

  const metricsResult = await Metrics.newItem({
    consumer_name: authArtifacts.id,
    watchdog_id: requestId,
    type: image.contentType,
  });

  log.verbose("metricsResult", { metricsResult });

  const responseData = {
    id: requestId,
    negative_uri,
    positive_uri,
    positive_email,
  };
  log.info("summary", responseData);
  return response(201, responseData);
};

function response(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: Object.assign({ "Content-Type": "application/json" }, headers),
    body: JSON.stringify(body),
  };
}

function getContentType(event) {
  let contentType = event.headers["content-type"];
  if (!contentType) {
    return event.headers["Content-Type"];
  }
  return contentType;
}

function parseRequestBody(event) {
  return new Promise((resolve, reject) => {
    const result = {};
    const busboy = new Busboy({
      headers: { "content-type": getContentType(event) },
    });
    busboy.on(
      "file",
      (fieldname, file, filename, contentEncoding, contentType) => {
        result[fieldname] = { filename, contentEncoding, contentType };
        const parts = [];
        file.on("data", data => parts.push(data));
        file.on("end", () => (result[fieldname].data = Buffer.concat(parts)));
      }
    );
    busboy.on("field", (fieldname, value) => (result[fieldname] = value));
    busboy.on("error", error => reject(`Parse error: ${error}`));
    busboy.on("finish", () => resolve(result));
    busboy.write(event.body, event.isBase64Encoded ? "base64" : "binary");
    busboy.end();
  });
}

// In-memory credentials lookup cache, only lasts until next deployment or
// container is recycled. Saves a DynamoDB hit and ~900ms for most requests
const credentialsCache = {};

async function lookupCredentials(id) {
  const {
    ENABLE_DEV_AUTH,
    DISABLE_AUTH_CACHE,
    CREDENTIALS_TABLE: TableName,
  } = process.env;

  let out;

  if (ENABLE_DEV_AUTH === "1" && id in DEV_CREDENTIALS) {
    out = DEV_CREDENTIALS[id];
  } else if (DISABLE_AUTH_CACHE !== "1" && id in credentialsCache) {
    out = credentialsCache[id];
  } else {
    const result = await documentClient
      .get({
        TableName,
        Key: { id },
        AttributesToGet: ["key", "algorithm"],
      })
      .promise();
    if (!result.Item) {
      out = null;
    } else {
      const {
        Item: { key, algorithm = DEFAULT_HAWK_ALGORITHM },
      } = result;
      out = credentialsCache[id] = { id, key, algorithm };
    }
  }

  return out;
}
