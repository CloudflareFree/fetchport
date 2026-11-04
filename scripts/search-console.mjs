#!/usr/bin/env node
/** Search Console sitemap submission and index-status inspection. Node 24+. */
import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";

const command = process.argv[2];
if (!["submit", "status", "inspect"].includes(command) || process.argv.length > 3) {
  console.error("Usage: node scripts/search-console.mjs <submit|status|inspect>");
  process.exit(1);
}

const site = process.env.GSC_SITE_URL || "sc-domain:137101.xyz";
const sitemap = process.env.GSC_SITEMAP_URL || "https://fetchport.137101.xyz/sitemap.xml";
const inspectionUrl = process.env.GSC_INSPECTION_URL || "https://fetchport.137101.xyz/";
const api = "https://www.googleapis.com/webmasters/v3";
const sitemapEndpoint = `${api}/sites/${encodeURIComponent(site)}/sitemaps/${encodeURIComponent(sitemap)}`;

async function jsonRequest(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(35_000) });
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body}`);
  return { status: response.status, data: body ? JSON.parse(body) : null };
}

async function main() {
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyFile) throw new Error("Set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON file outside the repository.");
  const sa = JSON.parse(readFileSync(keyFile, "utf8"));
  if (sa.type !== "service_account" || !sa.private_key || !sa.client_email) {
    throw new Error("Expected a service-account key with client_email and private_key.");
  }
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT", kid: sa.private_key_id })}.${encode({
    iss: sa.client_email,
    scope: `https://www.googleapis.com/auth/${command === "submit" ? "webmasters" : "webmasters.readonly"}`,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(sa.private_key).toString("base64url");
  const { data: auth } = await jsonRequest("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
  });
  if (!auth.access_token) throw new Error("Google returned no access token.");
  const headers = { Authorization: `Bearer ${auth.access_token}` };

  if (command === "inspect") {
    const result = await jsonRequest("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ inspectionUrl, siteUrl: site, languageCode: "zh-CN" }),
    });
    console.log(JSON.stringify({ site, inspectionUrl, ...result }, null, 2));
    return;
  }

  if (command === "submit") {
    const { data: sites } = await jsonRequest(`${api}/sites`, { headers });
    const permission = sites.siteEntry?.find((entry) => entry.siteUrl === site)?.permissionLevel;
    if (!["siteOwner", "siteFullUser"].includes(permission)) {
      throw new Error(`Service account needs owner/full-user access to ${site}; current permission: ${permission || "missing"}.`);
    }
    const result = await jsonRequest(sitemapEndpoint, { method: "PUT", headers });
    // Print receipt before checking status so a later read failure cannot hide a successful submission.
    console.log(JSON.stringify({ action: "sitemap-submitted", site, sitemap, ...result }, null, 2));
  }
  const result = await jsonRequest(sitemapEndpoint, { headers });
  console.log(JSON.stringify({ action: "sitemap-status", site, sitemap, ...result }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
