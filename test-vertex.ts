import { createVertex } from "@ai-sdk/google-vertex";
import { generateText } from "ai";
import { z } from "zod";
import * as fs from "fs";

async function testVertexAI() {
  const credentials = JSON.parse(fs.readFileSync("./talento.json", "utf-8"));
  
  const vertex = createVertex({
    project: credentials.project_id,
    location: "us-central1",
    googleAuthOptions: { credentials },
  });

  const schema = z.object({
    name: z.string(),
    value: z.number(),
  });

  const safetySettings = [
    { category: "HARM_CATEGORY_HATE_SPEECH" as const, threshold: "BLOCK_NONE" as const },
    { category: "HARM_CATEGORY_DANGEROUS_CONTENT" as const, threshold: "BLOCK_NONE" as const },
    { category: "HARM_CATEGORY_HARASSMENT" as const, threshold: "BLOCK_NONE" as const },
    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT" as const, threshold: "BLOCK_NONE" as const },
    { category: "HARM_CATEGORY_CIVIC_INTEGRITY" as const, threshold: "BLOCK_NONE" as const },
  ];

  try {
    console.log("Testing with generateText...");
    const { text, usage, finishReason, providerMetadata } = await generateText({
      model: vertex("gemini-2.5-pro"),
      prompt: "Generate a JSON object with name 'test' and value 42. Return only raw JSON, no markdown.",
      temperature: 0,
      maxTokens: 1000,
      providerOptions: {
        vertex: {
          safetySettings,
          structuredOutputs: false,
        },
      },
    });

    console.log("Text:", text);
    console.log("Usage:", usage);
    console.log("FinishReason:", finishReason);
    console.log("ProviderMetadata:", JSON.stringify(providerMetadata, null, 2));
  } catch (e) {
    console.error("Error with generateText:", e);
  }

  // Test with generateObject to see if it works now
  try {
    console.log("\nTesting with generateObject...");
    const { generateObject } = await import("ai");
    const { object, usage, finishReason, providerMetadata } = await generateObject({
      model: vertex("gemini-2.5-pro"),
      prompt: "Generate an object with name 'test' and value 42",
      temperature: 0,
      schema,
      mode: "json",
      providerOptions: {
        vertex: {
          safetySettings,
          structuredOutputs: false,
        },
      },
    });

    console.log("Object:", object);
    console.log("Usage:", usage);
    console.log("FinishReason:", finishReason);
    console.log("ProviderMetadata:", JSON.stringify(providerMetadata, null, 2));
  } catch (e) {
    console.error("Error with generateObject:", e);
  }

  // Test with a long prompt similar to a PR review
  try {
    console.log("\nTesting with long prompt (like PR review)...");
    const longPrompt = `
You are a code reviewer. Review this code change:

## File: 'src/test.ts'

@@ -1,5 +1,6 @@
__new hunk__
1  import { something } from 'somewhere';
2  
3 +function newFunction() {
4 +  // Added comment
5    return true;
6  }

You must respond with a single valid JSON object.
`;

    const { text, usage, finishReason, providerMetadata } = await generateText({
      model: vertex("gemini-2.5-pro"),
      prompt: longPrompt,
      temperature: 0,
      maxTokens: 2000,
      providerOptions: {
        vertex: {
          safetySettings,
          structuredOutputs: false,
        },
      },
    });

    console.log("Text length:", text?.length);
    console.log("Text:", text?.substring(0, 500));
    console.log("Usage:", usage);
    console.log("FinishReason:", finishReason);
    console.log("ProviderMetadata:", JSON.stringify(providerMetadata, null, 2));
  } catch (e) {
    console.error("Error with long prompt:", e);
  }
}

testVertexAI().catch(console.error);
