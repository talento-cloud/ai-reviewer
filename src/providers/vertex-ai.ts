import { AIProvider, InferenceConfig } from "@/ai";
import config from "../config";
import { info } from "@actions/core";
import { generateObject } from "ai";
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

    const { object, usage } = await generateObject({
      model: vertex(this.modelName),
      prompt,
      temperature: temperature || 0,
      system,
      schema,
    });

    if (process.env.DEBUG) {
      info(`usage: \n${JSON.stringify(usage, null, 2)}`);
    }

    return object;
  }
}
