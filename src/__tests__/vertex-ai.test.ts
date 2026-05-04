import { VertexAIProvider } from "../providers/vertex-ai";
import { generateText } from "ai";
import { z } from "zod";

jest.mock("ai");
jest.mock("../config", () => ({
  llmVertexServiceAccountJson: '{"client_email":"test@test.com","private_key":"key"}',
  llmVertexProjectId: "test-project",
  llmVertexLocation: "us-central1",
}));

describe("VertexAIProvider", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should parse JSON response correctly", async () => {
    const mockGenerateText = jest.mocked(generateText);
    mockGenerateText.mockResolvedValue({
      text: '{"name":"test","value":42}',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      finishReason: "stop",
      providerMetadata: {},
    } as any);

    const provider = new VertexAIProvider("gemini-2.5-pro");
    const schema = z.object({
      name: z.string(),
      value: z.number(),
    });

    const result = await provider.runInference({
      prompt: "Generate a test object",
      system: "You are a test assistant",
      schema,
    });

    expect(result).toEqual({ name: "test", value: 42 });
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });

  it("should handle markdown code blocks in response", async () => {
    const mockGenerateText = jest.mocked(generateText);
    mockGenerateText.mockResolvedValue({
      text: '```json\n{"name":"test","value":42}\n```',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      finishReason: "stop",
      providerMetadata: {},
    } as any);

    const provider = new VertexAIProvider("gemini-2.5-pro");
    const schema = z.object({
      name: z.string(),
      value: z.number(),
    });

    const result = await provider.runInference({
      prompt: "Generate a test object",
      schema,
    });

    expect(result).toEqual({ name: "test", value: 42 });
  });

  it("should retry with different safety settings on empty response", async () => {
    const mockGenerateText = jest.mocked(generateText);
    // First call returns empty, second call returns valid JSON
    mockGenerateText
      .mockResolvedValueOnce({
        text: "",
        usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 },
        finishReason: "stop",
        providerMetadata: { vertex: { safetyRatings: [{ category: "HARM_CATEGORY_DANGEROUS_CONTENT", probability: "HIGH", blocked: true }] } },
      } as any)
      .mockResolvedValueOnce({
        text: '{"name":"test","value":42}',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        finishReason: "stop",
        providerMetadata: {},
      } as any);

    const provider = new VertexAIProvider("gemini-2.5-pro");
    const schema = z.object({
      name: z.string(),
      value: z.number(),
    });

    const result = await provider.runInference({
      prompt: "Generate a test object",
      schema,
    });

    expect(result).toEqual({ name: "test", value: 42 });
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
  });

  it("should throw error after all retries fail", async () => {
    const mockGenerateText = jest.mocked(generateText);
    mockGenerateText.mockResolvedValue({
      text: "",
      usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 },
      finishReason: "stop",
      providerMetadata: {},
    } as any);

    const provider = new VertexAIProvider("gemini-2.5-pro");
    const schema = z.object({
      name: z.string(),
      value: z.number(),
    });

    await expect(
      provider.runInference({
        prompt: "Generate a test object",
        schema,
      })
    ).rejects.toThrow("Failed to get response from Vertex AI after all attempts");

    expect(mockGenerateText).toHaveBeenCalledTimes(2);
  });
});
