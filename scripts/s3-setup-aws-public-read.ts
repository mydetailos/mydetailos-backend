/**
 * One-time AWS S3 setup for My Detail OS:
 * 1. Turns OFF bucket-level Block Public Access (all four switches).
 * 2. Sets a bucket policy allowing anonymous s3:GetObject under avatars/*, job-cards/*, and branding/*.
 *
 * Run from backend/:   npm run s3:setup-aws-public-read
 *
 * Flags:
 *   --dry-run          Print bucket policy JSON only.
 *   --policy-only      Skip PutPublicAccessBlock (use if IAM denies it). Turn off Block Public Access
 *                      manually: S3 → bucket → Permissions → Block public access → Edit → all OFF.
 *
 * Requires in .env: S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY.
 * Omit S3_ENDPOINT (AWS S3 only).
 *
 * IAM: attach policies from scripts/iam-s3-setup-policy.example.json (replace bucket name), or use
 * AmazonS3FullAccess while learning. Needs at least s3:PutBucketPolicy on the bucket resource.
 *
 * If URLs still return AccessDenied after this: disable Block Public Access at ACCOUNT level
 * (S3 → Block Public Access settings for this account). This script cannot change account-wide settings.
 */

import "dotenv/config";
import {
  GetBucketPolicyCommand,
  GetPublicAccessBlockCommand,
  PutBucketPolicyCommand,
  PutPublicAccessBlockCommand,
  S3Client,
} from "@aws-sdk/client-s3";

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`Missing ${name} in .env (copy from env.example).`);
    process.exit(1);
  }
  return v;
}

function bucketPolicyJson(bucket: string): string {
  return JSON.stringify(
    {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "My Detail OSPublicReadAssets",
          Effect: "Allow",
          Principal: "*",
          Action: "s3:GetObject",
          Resource: [
            `arn:aws:s3:::${bucket}/avatars/*`,
            `arn:aws:s3:::${bucket}/job-cards/*`,
            `arn:aws:s3:::${bucket}/branding/*`,
          ],
        },
      ],
    },
    null,
    2
  );
}

async function main() {
  if (process.env.S3_ENDPOINT?.trim()) {
    console.error(
      "S3_ENDPOINT is set — this script targets AWS S3 only.\n" +
        "For R2/MinIO, configure public access in your provider’s dashboard.\n" +
        "Unset S3_ENDPOINT for AWS, or use the AWS console for hybrid setups."
    );
    process.exit(1);
  }

  const bucket = requireEnv("S3_BUCKET");
  const region = process.env.S3_REGION?.trim() || "us-east-1";
  const accessKeyId = requireEnv("S3_ACCESS_KEY_ID");
  const secretAccessKey = requireEnv("S3_SECRET_ACCESS_KEY");

  const client = new S3Client({
    region,
    credentials: { accessKeyId, secretAccessKey },
  });

  console.log(`Bucket: ${bucket}`);
  console.log(`Region: ${region}`);

  const dryRun = process.argv.includes("--dry-run");
  const policyOnly = process.argv.includes("--policy-only");
  if (dryRun) {
    console.log("\n[dry-run] Would apply PublicAccessBlock (all false) + bucket policy:\n");
    console.log(bucketPolicyJson(bucket));
    process.exit(0);
  }

  if (policyOnly) {
    console.log(
      "\n1) Skipping Block Public Access API (--policy-only).\n" +
        "   If you have not already: S3 → bucket → Permissions → Block public access → Edit → turn OFF all four → Save.\n"
    );
  } else {
    console.log("\n1) Setting bucket Block Public Access → off (all four)…");
    try {
      await client.send(
        new PutPublicAccessBlockCommand({
          Bucket: bucket,
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: false,
            IgnorePublicAcls: false,
            BlockPublicPolicy: false,
            RestrictPublicBuckets: false,
          },
        })
      );
      try {
        const pab = await client.send(new GetPublicAccessBlockCommand({ Bucket: bucket }));
        console.log("   OK:", JSON.stringify(pab.PublicAccessBlockConfiguration));
      } catch {
        console.log("   (Could not read back PublicAccessBlock — continuing.)");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const denied =
        /not authorized|AccessDenied|PutBucketPublicAccessBlock/i.test(msg);
      if (!denied) throw e;
      console.warn(`
⚠ IAM user cannot call s3:PutBucketPublicAccessBlock (expected if you only granted object upload).

Do ONE of the following:

  A) Console (works with root or any login that can edit the bucket):
     S3 → Buckets → ${bucket} → Permissions → Block public access → Edit
     → turn OFF all four switches → Save.

  B) Attach bucket-level permissions to IAM user mydetailos-api:
     Copy scripts/iam-s3-setup-policy.example.json → replace REPLACE_WITH_YOUR_BUCKET_NAME
     → IAM → Users → mydetailos-api → Add permissions → Create inline policy → JSON → paste → Save.

Then run:
     npm run s3:setup-aws-public-read -- --policy-only

Continuing to step 2 (bucket policy). If this fails too, add s3:PutBucketPolicy for arn:aws:s3:::${bucket}
`);
    }
  }

  console.log("\n2) Applying bucket policy (public GetObject on avatars/*, job-cards/*, branding/*)…");
  await client.send(
    new PutBucketPolicyCommand({
      Bucket: bucket,
      Policy: bucketPolicyJson(bucket),
    })
  );

  try {
    const pol = await client.send(new GetBucketPolicyCommand({ Bucket: bucket }));
    console.log("   Policy saved. Snippet:", pol.Policy?.slice(0, 200) + "…");
  } catch {
    console.log("   Policy saved (could not re-fetch).");
  }

  const baseUrl =
    process.env.S3_PUBLIC_BASE_URL?.trim().replace(/\/+$/, "") ||
    `https://${bucket}.s3.${region}.amazonaws.com`;

  console.log(`
Done.

Test in a private browser window:
  ${baseUrl}/avatars/<some-key-under-avatars>

Set in backend/.env (no trailing slash):
  S3_PUBLIC_BASE_URL=${baseUrl}

If you still get AccessDenied:
  • S3 console → Block Public Access settings for this ACCOUNT → turn off all four (account rules can override the bucket).
  • Object must use SSE-S3 default encryption, not SSE-KMS CMK, unless you adjust KMS policies.

Note: This replaces the entire bucket policy. Merge manually in AWS if you had other statements.
`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
