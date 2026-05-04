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

    const jsonInstruction = `\n\nYou must respond with a single valid JSON object that matches this schema:\n${JSON.stringify(schema, null, 2)}\nDo not include any other text, markdown formatting, or code blocks. Only output the raw JSON object.`;

    const { text, usage } = await generateText({
      model: vertex(this.modelName),
      prompt: prompt + jsonInstruction,
      temperature: temperature || 0,
      system: system,
    });

    if (process.env.DEBUG) {
      info(`usage: \n${JSON.stringify(usage, null, 2)}`);
      info(`raw response: \n${text}`);
    }

    // Parse JSON from response (handle markdown code blocks)
    let jsonText = text.trim();
    const codeBlockMatch = jsonText.match(/^```(?:json)?\s*([\s\S]*?)```$/);
    if (codeBlockMatch) {
      jsonText = codeBlockMatch[1].trim();
    }

    try {
      const parsed = JSON.parse(jsonText);
      return schema.parse(parsed);
    } catch (e) {
      throw new Error(
        `Failed to parse or validate response from Vertex AI. Response: "${text}". Error: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
}
