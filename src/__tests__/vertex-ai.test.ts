import { VertexAIProvider } from "../providers/vertex-ai";
import { z } from "zod";

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

jest.mock("../config", () => ({
  llmVertexServiceAccountJson: JSON.stringify({
    type: "service_account",
    project_id: "test-project",
    private_key_id: "key-id",
    private_key: "fake-key",
    client_email: "test@test.com",
    token_uri: "https://oauth2.googleapis.com/token",
  }),
  llmVertexProjectId: "test-project",
  llmVertexLocation: "us-central1",
}));

describe("VertexAIProvider", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const createProviderWithMockToken = () => {
    const provider = new VertexAIProvider("gemini-2.5-pro");
    // Mock getAccessToken to avoid JWT signing issues in tests
    jest.spyOn(provider as any, "getAccessToken").mockResolvedValue("mock-token");
    return provider;
  };

  it("should parse JSON response correctly", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: '{"name":"test","value":42}' }],
            },
            finishReason: "STOP",
          },
        ],
      }),
    });

    const provider = createProviderWithMockToken();
    const schema = z.object({
      name: z.string(),
      value: z.number(),
    });

    const result = await provider.runInference({
      prompt: "Generate a test object",
      schema,
    });

    expect(result).toEqual({ name: "test", value: 42 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("should handle markdown code blocks in response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: '```json\n{"name":"test","value":42}\n```' }],
            },
            finishReason: "STOP",
          },
        ],
      }),
    });

    const provider = createProviderWithMockToken();
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

  it("should throw error on API error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: "Invalid request" } }),
    });

    const provider = createProviderWithMockToken();
    const schema = z.object({
      name: z.string(),
    });

    await expect(
      provider.runInference({
        prompt: "Generate a test object",
        schema,
      })
    ).rejects.toThrow("Vertex AI API error");
  });

  it("should throw error on blocked content", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        promptFeedback: {
          blockReason: "SAFETY",
        },
      }),
    });

    const provider = createProviderWithMockToken();
    const schema = z.object({
      name: z.string(),
    });

    await expect(
      provider.runInference({
        prompt: "Generate a test object",
        schema,
      })
    ).rejects.toThrow("Vertex AI blocked the prompt");
  });

  it("should throw error on empty response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: "" }],
            },
            finishReason: "STOP",
          },
        ],
      }),
    });

    const provider = createProviderWithMockToken();
    const schema = z.object({
      name: z.string(),
    });

    await expect(
      provider.runInference({
        prompt: "Generate a test object",
        schema,
      })
    ).rejects.toThrow("Vertex AI returned empty text");
  });

  it("should fix string-to-array mismatch", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: '{"type":"feat","name":"test"}' }],
            },
            finishReason: "STOP",
          },
        ],
      }),
    });

    const provider = createProviderWithMockToken();
    const schema = z.object({
      type: z.array(z.string()),
      name: z.string(),
    });

    const result = await provider.runInference({
      prompt: "Generate a test object",
      schema,
    });

    expect(result).toEqual({ type: ["feat"], name: "test" });
  });

  it("should fix object-to-array mismatch for files", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: '{"files":{"a.ts":"summary A","b.ts":"summary B"},"title":"test"}' }],
            },
            finishReason: "STOP",
          },
        ],
      }),
    });

    const provider = createProviderWithMockToken();
    const fileSchema = z.object({
      filename: z.string(),
      summary: z.string(),
      title: z.string(),
    });
    const schema = z.object({
      files: z.array(fileSchema),
      title: z.string(),
    });

    const result = await provider.runInference({
      prompt: "Generate a test object",
      schema,
    });

    expect(result.files).toHaveLength(2);
    expect(result.files[0]).toMatchObject({ filename: "a.ts", summary: "summary A" });
    expect(result.files[1]).toMatchObject({ filename: "b.ts", summary: "summary B" });
    expect(result.title).toBe("test");
  });
});
