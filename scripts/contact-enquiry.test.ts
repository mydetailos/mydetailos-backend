import test from "node:test";
import assert from "node:assert/strict";
import {
  SUPPORT_EMAIL,
  sendContactEnquiryEmail,
} from "../src/services/contact-email.service.js";
import { postPublicContact } from "../src/controllers/public.controller.js";
import { errorHandler } from "../src/middleware/error-handler.js";

function createMockReqRes(body: any, ip = "127.0.0.1") {
  const req: any = {
    body,
    headers: { "x-forwarded-for": ip },
    ip,
  };
  let statusCode = 200;
  let responseData: any = null;
  const res: any = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(data: any) {
      responseData = data;
      return res;
    },
  };
  let nextCalledWith: any = null;
  const next = (err?: any) => {
    nextCalledWith = err;
    if (err) {
      errorHandler(err, req, res, (() => {}) as any);
    }
  };
  return {
    req,
    res,
    next,
    getStatus: () => statusCode,
    getData: () => responseData,
    getNextErr: () => nextCalledWith,
  };
}

test("Contact Email Service - Recipient is exactly support@mydetailos.com", () => {
  assert.equal(
    SUPPORT_EMAIL,
    "support@mydetailos.com",
    "Support recipient email must be support@mydetailos.com"
  );
});

test("Contact Email Service - Formats all required details with Reply-To", async () => {
  let capturedParams: any = null;
  const mockSender = async (params: any) => {
    capturedParams = params;
    return { ok: true as const, id: "msg_test_123" };
  };

  const testDate = new Date("2026-11-19T10:30:00.000Z");
  const result = await sendContactEnquiryEmail(
    {
      name: "Aman Sharma",
      email: "aman@autodetailers.in",
      phone: "+91 98765 43210",
      businessName: "Aman Detailing Hub",
      subject: "Enterprise Onboarding Enquiry",
      message: "We have 4 branches in Mumbai and want to migrate to MyDetailOS.",
      submissionDate: testDate,
      source: "public_website",
    },
    mockSender
  );

  assert.equal(result.ok, true);
  assert.ok(capturedParams, "mockSender must be called");

  // 1. Recipient check: exactly support@mydetailos.com
  assert.deepEqual(capturedParams.to, ["support@mydetailos.com"]);

  // 2. Reply-To check: Must be the customer's email
  assert.equal(capturedParams.replyTo, "aman@autodetailers.in");

  // 3. Subject line
  assert.ok(
    capturedParams.subject.includes("Enterprise Onboarding Enquiry"),
    "Subject line should include enquiry subject"
  );
  assert.ok(
    capturedParams.subject.includes("Aman Sharma"),
    "Subject line should include customer name"
  );

  // 4. HTML content checks
  const html = capturedParams.html;
  assert.ok(html.includes("Aman Sharma"), "HTML must contain customer name");
  assert.ok(html.includes("aman@autodetailers.in"), "HTML must contain email address");
  assert.ok(html.includes("+91 98765 43210"), "HTML must contain phone number");
  assert.ok(html.includes("Aman Detailing Hub"), "HTML must contain business name");
  assert.ok(html.includes("Enterprise Onboarding Enquiry"), "HTML must contain subject");
  assert.ok(html.includes("We have 4 branches in Mumbai"), "HTML must contain message");
  assert.ok(html.includes("Submission Date and Time"), "HTML must contain submission date header");
  assert.ok(html.includes("public_website"), "HTML must contain source");

  // 5. Text content checks
  const text = capturedParams.text;
  assert.ok(text.includes("Customer Name: Aman Sharma"), "Text must contain customer name");
  assert.ok(text.includes("Email Address: aman@autodetailers.in"), "Text must contain email");
  assert.ok(text.includes("Phone Number: +91 98765 43210"), "Text must contain phone");
  assert.ok(text.includes("Business Name: Aman Detailing Hub"), "Text must contain business name");
  assert.ok(text.includes("Subject: Enterprise Onboarding Enquiry"), "Text must contain subject");
  assert.ok(text.includes("We have 4 branches in Mumbai"), "Text must contain message");
  assert.ok(text.includes("Submission Date and Time:"), "Text must contain date");
});

test("Contact Email Service - Handles optional phone and businessName omission", async () => {
  let capturedParams: any = null;
  const mockSender = async (params: any) => {
    capturedParams = params;
    return { ok: true as const, id: "msg_test_456" };
  };

  const result = await sendContactEnquiryEmail(
    {
      name: "Rohit Verma",
      email: "rohit@gmail.com",
      phone: null,
      businessName: null,
      subject: null,
      message: "Interested in the standard workshop plan.",
    },
    mockSender
  );

  assert.equal(result.ok, true);
  assert.ok(capturedParams);
  assert.deepEqual(capturedParams.to, ["support@mydetailos.com"]);
  assert.equal(capturedParams.replyTo, "rohit@gmail.com");

  const html = capturedParams.html;
  assert.ok(html.includes("Rohit Verma"));
  assert.ok(html.includes("Not provided"), "Missing phone should show 'Not provided'");

  const text = capturedParams.text;
  assert.ok(text.includes("Phone Number: Not provided"));
});

test("Contact Email Service - Escapes HTML to prevent injection", async () => {
  let capturedParams: any = null;
  const mockSender = async (params: any) => {
    capturedParams = params;
    return { ok: true as const, id: "msg_test_xss" };
  };

  await sendContactEnquiryEmail(
    {
      name: '<script>alert("hack")</script>',
      email: "test@example.com",
      message: '<img src=x onerror="alert(1)"> & bold message',
    },
    mockSender
  );

  assert.ok(capturedParams);
  const html = capturedParams.html;
  assert.ok(!html.includes("<script>"), "Raw <script> tags must not exist in HTML");
  assert.ok(
    html.includes("&lt;script&gt;alert(&quot;hack&quot;)&lt;/script&gt;"),
    "Name must be escaped"
  );
  assert.ok(html.includes("&amp; bold message"), "Ampersands must be escaped");
});

test("Contact Controller - Validates invalid form data (missing name)", async () => {
  const { req, res, next, getStatus, getData } = createMockReqRes({
    name: "",
    email: "test@example.com",
    message: "Valid message here",
  }, "10.0.0.1");

  await postPublicContact(req, res, next);
  assert.equal(getStatus(), 400, "Missing name must return 400");
  assert.equal(getData().error.code, "VALIDATION");
});

test("Contact Controller - Validates invalid form data (invalid email)", async () => {
  const { req, res, next, getStatus, getData } = createMockReqRes({
    name: "Valid Name",
    email: "not-an-email",
    message: "Valid message here",
  }, "10.0.0.2");

  await postPublicContact(req, res, next);
  assert.equal(getStatus(), 400, "Invalid email must return 400");
  assert.equal(getData().error.code, "VALIDATION");
});

test("Contact Controller - Validates invalid form data (empty message)", async () => {
  const { req, res, next, getStatus, getData } = createMockReqRes({
    name: "Valid Name",
    email: "test@example.com",
    message: "   ",
  }, "10.0.0.3");

  await postPublicContact(req, res, next);
  assert.equal(getStatus(), 400, "Empty message must return 400");
  assert.equal(getData().error.code, "VALIDATION");
});

test("Contact Controller - Handles email delivery failure safely with 502 and support message", async () => {
  const prevKey = process.env.RESEND_API_KEY;
  // Use invalid key to deliberately trigger failure path
  process.env.RESEND_API_KEY = "re_deliberately_invalid_for_testing";

  try {
    const { req, res, next, getStatus, getData } = createMockReqRes({
      name: "Aman Sharma",
      email: "aman@autodetailers.in",
      message: "Enquiry about detailing software",
    }, "10.0.0.99");

    await postPublicContact(req, res, next);
    assert.equal(getStatus(), 502, "Failed email delivery must return 502 Bad Gateway");
    assert.ok(
      getData().error.message.includes("support@mydetailos.com"),
      "Error message must include support@mydetailos.com"
    );
  } finally {
    process.env.RESEND_API_KEY = prevKey;
  }
});

test("Contact Controller - Enforces rate limiting on repeated spam submissions", async () => {
  const spamIp = "192.168.99.1";
  let lastStatus = 200;

  for (let i = 0; i < 25; i++) {
    const { req, res, next, getStatus } = createMockReqRes({
      name: "Spam Bot",
      email: "spam@example.com",
      message: "Spam message",
    }, spamIp);

    await postPublicContact(req, res, next);
    lastStatus = getStatus();
  }

  assert.equal(lastStatus, 429, "Submissions exceeding rate limit must return 429");
});
