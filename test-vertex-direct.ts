import * as fs from "fs";

async function testVertexDirectAPI() {
  const credentials = JSON.parse(fs.readFileSync("./talento.json", "utf-8"));
  
  // Get access token
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: await createJWT(credentials),
    }),
  });

  if (!tokenResponse.ok) {
    console.error("Token error:", await tokenResponse.text());
    return;
  }

  const { access_token } = await tokenResponse.json();
  console.log("Got access token successfully");

  const projectId = credentials.project_id;
  const location = "us-central1";
  
  // Test with gemini-2.5-pro
  const modelId = "gemini-2.5-pro";
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${modelId}:generateContent`;

  console.log("Calling URL:", url);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [{
        role: "user",
        parts: [{ text: "Say hello and return a JSON object with {message: 'hello'}" }]
      }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 1000,
      },
      safetySettings: [
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" },
      ],
    }),
  });

  const data = await response.json();
  console.log("Response status:", response.status);
  console.log("Response:", JSON.stringify(data, null, 2));
}

async function createJWT(credentials: any): Promise<string> {
  const crypto = await import("crypto");
  
  const header = Buffer.from(JSON.stringify({
    alg: "RS256",
    typ: "JWT",
    kid: credentials.private_key_id,
  })).toString("base64url");

  const now = Math.floor(Date.now() / 1000);
  const claim = Buffer.from(JSON.stringify({
    iss: credentials.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: credentials.token_uri,
    iat: now,
    exp: now + 3600,
  })).toString("base64url");

  const sign = crypto.createSign("RSA-SHA256");
  sign.update(`${header}.${claim}`);
  const signature = sign.sign(credentials.private_key, "base64url");

  return `${header}.${claim}.${signature}`;
}

testVertexDirectAPI().catch(console.error);
