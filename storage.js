const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  GetBucketCorsCommand
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const detectFileType = require("detect-file-type");
const util = require('util');

const S3_CONFIG = {
  endpoint: "",
  region: "",
  credentials: {
    accessKeyId: "",
    secretAccessKey: "",
  },
};
const META_BUCKET = "dingo-nft-meta";
const PREVIEW_BUCKET = "dingo-nft-preview";
const CONTENT_BUCKET = "dingo-nft-content";
const STATE_BUCKET = "dingo-nft-state";
const PROFILE_BUCKET = "dingo-nft-profile";
const COLLECTION_BUCKET = "dingo-nft-collection";
const CONTENT_AUTHORIZATION_TIMEOUT = 30; // In seconds.

let s3 = null;

const createClient = () => {
  s3 = new S3Client(S3_CONFIG);
};


const uploadMeta = (address, meta) => {
  return s3.send(
    new PutObjectCommand({
      Bucket: META_BUCKET,
      Key: address,
      Body: JSON.stringify(meta),
      ContentType: "application/json"
    })
  );
};

const uploadPreview = (address, data) => {
  return s3.send(
    new PutObjectCommand({
      Bucket: PREVIEW_BUCKET,
      Key: address + ".png",
      Body: data,
      ContentType: "image/png"
    })
  );
};

const uploadContent = async (address, data) => {
  const type = await util.promisify((callback) => {
    detectFileType.fromBuffer(data, (err, res) => {
      if (res === null) {
        callback(null,  { mime: "application/octet-stream" });
      } else {
        callback(null, res);
      }
    });
  })();

  return await s3.send(
    new PutObjectCommand({
      Bucket: CONTENT_BUCKET,
      Key: address,
      Body: data,
      ContentType: type.mime
    })
  );
};

const authorizeContent = (address) => {
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: CONTENT_BUCKET,
      Key: address,
    }),
    {
      expiresIn: CONTENT_AUTHORIZATION_TIMEOUT,
    }
  );
};

const uploadState = async (address, data) => {
  return s3.send(
    new PutObjectCommand({
      Bucket: STATE_BUCKET,
      CacheControl: "max-age=0",
      Key: address,
      Body: JSON.stringify(data),
      ContentType: "application/json"
    })
  );
};

const uploadProfile = (owner, data) => {
  return s3.send(
    new PutObjectCommand({
      Bucket: PROFILE_BUCKET,
      CacheControl: "max-age=0",
      Key: owner,
      Body: JSON.stringify(data),
      ContentType: "application/json"
    })
  );
};

const uploadCollection = (handle, data) => {
  return s3.send(
    new PutObjectCommand({
      Bucket: COLLECTION_BUCKET,
      CacheControl: "max-age=0",
      Key: handle,
      Body: JSON.stringify(data),
      ContentType: "application/json"
    })
  );
};

module.exports = {
  createClient,
  uploadMeta,
  uploadPreview,
  uploadContent,
  authorizeContent,
  uploadState,
  uploadProfile,
  uploadCollection
};
