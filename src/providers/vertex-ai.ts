import { AIProvider, InferenceConfig } from "@/ai";
import config from "../config";
import { info } from "@actions/core";
import { generateText } from "ai";
import { createVertex } from "@ai-sdk/google-vertex";

export class VertexAIProvider implements AIProvider {
  private modelName: string;

  constructor(modelName: string) {
    this.modelName = modelName;
  }

  async runInference({
    prompt,
    temperature,
    system,
    schema,
  }: InferenceConfig): Promise<any> {
    let credentials: any;
    if (config.llmVertexServiceAccountJson) {
      try {
        credentials = JSON.parse(config.llmVertexServiceAccountJson);
      } catch (e) {
        throw new Error(
          `Invalid JSON in LLM_VERTEX_SERVICE_ACCOUNT_JSON: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }

    const vertex = createVertex({
      project: config.llmVertexProjectId || "",
      location: config.llmVertexLocation || "us-central1",
      ...(credentials && { googleAuthOptions: { credentials } }),
    });

    const fullPrompt = `${system || ''}\n\n${prompt}\n\nYou must respond with a single valid JSON object that matches this schema. Do not include any other text, markdown formatting, or code blocks. Only output the raw JSON object.`;

    // Retry logic with increasing safety thresholds
    const safetySettingsAttempts = [
      // First attempt: block only high risk
      [
        { category: "HARM_CATEGORY_HATE_SPEECH" as const, threshold: "BLOCK_ONLY_HIGH" as const },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT" as const, threshold: "BLOCK_ONLY_HIGH" as const },
        { category: "HARM_CATEGORY_HARASSMENT" as const, threshold: "BLOCK_ONLY_HIGH" as const },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT" as const, threshold: "BLOCK_ONLY_HIGH" as const },
        { category: "HARM_CATEGORY_CIVIC_INTEGRITY" as const, threshold: "BLOCK_ONLY_HIGH" as const },
      ],
      // Second attempt: block none
      [
        { category: "HARM_CATEGORY_HATE_SPEECH" as const, threshold: "BLOCK_NONE" as const },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT" as const, threshold: "BLOCK_NONE" as const },
        { category: "HARM_CATEGORY_HARASSMENT" as const, threshold: "BLOCK_NONE" as const },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT" as const, threshold: "BLOCK_NONE" as const },
        { category: "HARM_CATEGORY_CIVIC_INTEGRITY" as const, threshold: "BLOCK_NONE" as const },
      ],
    ];

    let lastError: Error | undefined;

    for (const safetySettings of safetySettingsAttempts) {
      try {
        const { text, usage, finishReason, providerMetadata } = await generateText({
          model: vertex(this.modelName),
          prompt: fullPrompt,
          temperature: temperature || 0,
          maxTokens: 8192,
          providerOptions: {
            vertex: {
              safetySettings,
              structuredOutputs: false,
            },
          },
        });

        if (process.env.DEBUG) {
          info(`usage: \n${JSON.stringify(usage, null, 2)}`);
          info(`finishReason: ${finishReason}`);
          info(`providerMetadata: \n${JSON.stringify(providerMetadata, null, 2)}`);
          info(`raw response: \n${text}`);
        }

        // Check if response was blocked by safety settings
        if (!text || text.trim().length === 0) {
          const safetyRatings = providerMetadata?.vertex?.safetyRatings;
          if (safetyRatings) {
            console.warn(`Vertex AI response was empty. Safety ratings: ${JSON.stringify(safetyRatings)}`);
          }
          throw new Error("Vertex AI returned an empty response");
        }

        // Parse JSON from response (handle markdown code blocks)
        let jsonText = text.trim();
        const codeBlockMatch = jsonText.match(/^```(?:json)?\s*([\s\S]*?)```$/);
        if (codeBlockMatch) {
          jsonText = codeBlockMatch[1].trim();
        }

        const parsed = JSON.parse(jsonText);
        return schema.parse(parsed);
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        console.warn(`Vertex AI attempt failed with safety settings, retrying... Error: ${lastError.message}`);
        // Continue to next safety settings attempt
      }
    }

    throw new Error(
      `Failed to get response from Vertex AI after all attempts. Last error: ${lastError?.message || "Unknown error"}`
    );
  }
}
