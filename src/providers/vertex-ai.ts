import { AIProvider, InferenceConfig } from "@/ai";
import config from "../config";
import { info } from "@actions/core";
import { z } from "zod";

export class VertexAIProvider implements AIProvider {
  private modelName: string;
  private credentials: any;
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;

  constructor(modelName: string) {
    this.modelName = modelName;
    if (config.llmVertexServiceAccountJson) {
      try {
        this.credentials = JSON.parse(config.llmVertexServiceAccountJson);
      } catch (e) {
        throw new Error(
          `Invalid JSON in LLM_VERTEX_SERVICE_ACCOUNT_JSON: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    const jwt = await this.createJWT();
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get access token: ${error}`);
    }

    const data = await response.json();
    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + (data.expires_in - 60) * 1000; // Refresh 1 min before expiry
    return this.accessToken;
  }

  private async createJWT(): Promise<string> {
    const crypto = await import("crypto");

    const header = Buffer.from(
      JSON.stringify({
        alg: "RS256",
        typ: "JWT",
        kid: this.credentials.private_key_id,
      })
    ).toString("base64url");

    const now = Math.floor(Date.now() / 1000);
    const claim = Buffer.from(
      JSON.stringify({
        iss: this.credentials.client_email,
        scope: "https://www.googleapis.com/auth/cloud-platform",
        aud: this.credentials.token_uri,
        iat: now,
        exp: now + 3600,
      })
    ).toString("base64url");

    const sign = crypto.createSign("RSA-SHA256");
    sign.update(`${header}.${claim}`);
    const signature = sign.sign(this.credentials.private_key, "base64url");

    return `${header}.${claim}.${signature}`;
  }

  async runInference({
    prompt,
    temperature,
    system,
    schema,
  }: InferenceConfig): Promise<any> {
    const projectId = config.llmVertexProjectId || this.credentials?.project_id || "";
    const location = config.llmVertexLocation || "us-central1";
    const accessToken = await this.getAccessToken();

    const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${this.modelName}:generateContent`;

    const safetySettings = [
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" },
    ];

    const contents: any[] = [];
    if (system) {
      contents.push({
        role: "user",
        parts: [{ text: system }],
      });
    }
    contents.push({
      role: "user",
      parts: [{ text: prompt + "\n\nYou must respond with a single valid JSON object. Do not include any other text, markdown formatting, or code blocks. Only output the raw JSON object." }],
    });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents,
        generationConfig: {
          temperature: temperature || 0,
          maxOutputTokens: 16384,
        },
        safetySettings,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        `Vertex AI API error: ${response.status} ${JSON.stringify(data)}`
      );
    }

    if (process.env.DEBUG) {
      info(`Vertex AI response: \n${JSON.stringify(data, null, 2)}`);
    }

    // Check for blocked content
    if (data.promptFeedback?.blockReason) {
      throw new Error(
        `Vertex AI blocked the prompt: ${data.promptFeedback.blockReason}`
      );
    }

    const candidate = data.candidates?.[0];
    if (!candidate) {
      throw new Error("Vertex AI returned no candidates");
    }

    if (candidate.finishReason && candidate.finishReason !== "STOP") {
      console.warn(`Vertex AI finish reason: ${candidate.finishReason}`);
    }

    const text = candidate.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error("Vertex AI returned empty text");
    }

    // Parse JSON from response (handle markdown code blocks)
    let jsonText = text.trim();
    const codeBlockMatch = jsonText.match(/^```(?:json)?\s*([\s\S]*?)```$/);
    if (codeBlockMatch) {
      jsonText = codeBlockMatch[1].trim();
    }

    try {
      let parsed = JSON.parse(jsonText);
      parsed = this.flexibleParse(parsed, schema);
      return schema.parse(parsed);
    } catch (e) {
      throw new Error(
        `Failed to parse or validate response from Vertex AI. Response: "${text}". Error: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  /**
   * Attempts to fix common schema mismatches before Zod validation.
   * Handles cases where the LLM returns:
   * - A string instead of an array (wraps in array)
   * - An object/dict instead of an array of objects (converts to array)
   */
  private flexibleParse(parsed: any, schema: z.ZodObject<any, any>): any {
    if (!parsed || typeof parsed !== "object") {
      return parsed;
    }

    const shape = schema.shape || (schema._def?.shape?.() as Record<string, z.ZodTypeAny>);
    if (!shape) {
      return parsed;
    }

    const result = { ...parsed };

    for (const [key, zodType] of Object.entries(shape)) {
      const value = result[key];
      if (value === undefined || value === null) {
        continue;
      }

      // Check if Zod expects an array
      const isArray = zodType instanceof z.ZodArray ||
        (zodType._def?.typeName === "ZodArray");

      if (isArray) {
        // If value is a string, wrap it in an array
        if (typeof value === "string") {
          result[key] = [value];
          continue;
        }

        // If value is an object (dict) instead of array, try to convert
        if (typeof value === "object" && !Array.isArray(value)) {
          const arrayValue = Object.entries(value).map(([k, v]) => {
            if (typeof v === "string") {
              // Common pattern: { filename: summary } -> { filename, summary }
              return { filename: k, summary: v, title: v.slice(0, 50) };
            }
            if (typeof v === "object" && v !== null) {
              return { filename: k, ...v };
            }
            return v;
          });
          result[key] = arrayValue;
        }
      }

      // Recursively fix nested objects
      if (zodType instanceof z.ZodObject && typeof value === "object" && !Array.isArray(value)) {
        result[key] = this.flexibleParse(value, zodType);
      }

      // Fix items inside arrays
      if (isArray && Array.isArray(value)) {
        const itemType = (zodType as z.ZodArray<any>).element;
        if (itemType instanceof z.ZodObject) {
          result[key] = value.map((item) =>
            typeof item === "object" && item !== null
              ? this.flexibleParse(item, itemType)
              : item
          );
        }
      }
    }

    return result;
  }
}
