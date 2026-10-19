import { createHash } from "crypto";
import axios from "axios";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
    "image/svg+xml": "svg",
};

export interface UploadImageOptions {
    /** Key prefix inside the bucket, e.g. "dining/menu-items". */
    folder?: string;
    /** Full object key. Overrides folder + generated name. */
    key?: string;
    contentType?: string;
}

let client: S3Client | null = null;

const getConfig = () => {
    const accessKeyId = process.env.S3_ACCESS_KEY_ID;
    const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
    const bucket = process.env.S3_BUCKET;
    const region = process.env.S3_REGION || "us-east-1";
    if (!accessKeyId || !secretAccessKey || !bucket) {
        throw new Error("S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY and S3_BUCKET must be set");
    }
    return { accessKeyId, secretAccessKey, bucket, region };
};

const getClient = (): S3Client => {
    if (!client) {
        const { accessKeyId, secretAccessKey, region } = getConfig();
        client = new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
    }
    return client;
};

export const isS3Configured = (): boolean =>
    !!(process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY && process.env.S3_BUCKET);

/** Public URL for an object key (CloudFront via CDN_URL, else the S3 URL). */
export const getPublicUrl = (key: string): string => {
    const cdn = process.env.CDN_URL?.replace(/\/+$/, "");
    if (cdn) return `${cdn}/${key}`;
    const { bucket, region } = getConfig();
    return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
};

/** True when the URL already points at our CDN/bucket (used to skip re-migration). */
export const isOwnS3Url = (url: string): boolean => {
    const cdn = process.env.CDN_URL?.replace(/\/+$/, "");
    if (cdn && url.startsWith(`${cdn}/`)) return true;
    const bucket = process.env.S3_BUCKET;
    return !!bucket && url.startsWith(`https://${bucket}.s3.`);
};

/** Uploads a buffer and returns its public URL. */
export const uploadBufferToS3 = async (
    body: Buffer,
    contentType: string,
    options: UploadImageOptions = {}
): Promise<string> => {
    const { bucket } = getConfig();
    const ext = EXTENSIONS[contentType.toLowerCase()] ?? "bin";
    const name = `${createHash("sha256").update(body).digest("hex")}.${ext}`;
    const key = options.key ?? `${(options.folder ?? "images").replace(/^\/+|\/+$/g, "")}/${name}`;

    await getClient().send(
        new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: contentType,
            CacheControl: "public, max-age=31536000, immutable",
        })
    );
    return getPublicUrl(key);
};

/**
 * Downloads an image from a remote URL and uploads it to S3.
 * Keys are content-hashed, so the same image is never stored twice.
 * Throws if the download fails or the response is not an image.
 */
export const uploadImageFromUrl = async (
    imageUrl: string,
    options: UploadImageOptions = {}
): Promise<string> => {
    const res = await axios.get<ArrayBuffer>(imageUrl, {
        responseType: "arraybuffer",
        timeout: 30_000,
        maxContentLength: MAX_IMAGE_BYTES,
        headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36", Accept: "image/*" },
    });

    const contentType = options.contentType
        ?? String(res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (!contentType.startsWith("image/")) {
        throw new Error(`Not an image (content-type "${contentType}"): ${imageUrl}`);
    }
    return uploadBufferToS3(Buffer.from(res.data), contentType, options);
};
