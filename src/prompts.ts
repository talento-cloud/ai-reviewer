import { runPrompt } from "./ai";
import { z } from "zod";
import { formatFileDiff, File, FileDiff, generateFileCodeDiff } from "./diff";
import { ReviewCommentThread } from "./comments";
import config from "./config";

type PullRequestSummaryPrompt = {
  prTitle: string;
  prDescription: string;
  commitMessages: string[];
  files: File[];
};

export type PullRequestSummary = {
  title: string;
  description: string;
  files: {
    filename: string;
    summary: string;
    title: string;
  }[];
  type: string[];
};

export async function runSummaryPrompt(
  pr: PullRequestSummaryPrompt
): Promise<PullRequestSummary> {
  let systemPrompt = `Eres un asistente útil que resume Pull Requests (PRs) de Git.`;

  systemPrompt += `Tu tarea es proporcionar una descripción completa del contenido del PR: título, tipo, descripción y resúmenes de los archivos afectados.\n`;

  systemPrompt += `
- Ten en cuenta que las secciones 'Original title', 'Original description' y 'Commit messages' pueden estar incompletas, ser simplistas, poco informativas o estar desactualizadas. Por lo tanto, compáralas con el código del diff del PR y úsalas solo como referencia.
- El título y la descripción generados deben priorizar los cambios más significativos.
- Al citar variables o nombres del código, usa backticks (\`).
- Devuelve un resumen para cada archivo afectado individualmente, o si no hay nada que resumir, usa simplemente el estado del cambio (ej. "Archivo nuevo").
- Comienza la descripción general con un verbo en pasado como "Inicio", "Agregó", "Generó", etc.

IMPORTANTE: No hagas suposiciones sobre el código fuera del diff. No asumas que una variable podría ser opcional si no ves su declaración de tipo. No sugieras verificaciones null a menos que estés seguro de que esto podría generar un error en tiempo de ejecución.
\n`;

  let userPrompt = `
Resume el siguiente PR:

<Original PR Title>${pr.prTitle}</Original PR Title>
<Original PR Description>
${pr.prDescription}
</Original PR Description>
<Commit Messages>
${pr.commitMessages.join("\n")}
</Commit Messages>

<Affected Files>
${pr.files.map((file) => `- ${file.status}: ${file.filename}`).join("\n")}
</Affected Files>

<File Diffs>
${pr.files.map((file) => formatFileDiff(file)).join("\n\n")}
</File Diffs>

Asegúrate de que cada archivo afectado esté resumido y sea parte del JSON devuelto.
`;

  const fileSchema = z.object({
    filename: z.string().default("").describe("The full file path of the relevant file"),
    summary: z
      .string()
      .default("")
      .describe(
        "Concise summary of the file changes in markdown format (max 70 words)"
      ),
    title: z
      .string()
      .default("")
      .describe(
        "An informative title for the changes in this file, describing its main theme (5-10 words)."
      ),
  });

  const schema = z.object({
    title: z
      .string()
      .default("")
      .describe(
        "Informative title of the PR, describing its main theme (10 words max)"
      ),
    description: z
      .string()
      .default("")
      .describe("Informative description of the PR, describing its main theme"),
    files: z
      .array(fileSchema)
      .default([])
      .describe(
        "List of files affected in the PR and summaries of their changes"
      ),
    type: z
      .array(z.string())
      .default(["OTHER"])
      .describe("One or more types that describe this PR's main theme. Example: BUG, TESTS, ENHANCEMENT, DOCUMENTATION, SECURITY, OTHER"),
  });

  return (await runPrompt({
    prompt: userPrompt,
    systemPrompt,
    schema,
  })) as PullRequestSummary;
}

export type AIComment = {
  file: string;
  start_line: number;
  end_line: number;
  highlighted_code: string;
  header: string;
  content: string;
  label: string;
  critical: boolean;
};

export type PullRequestReview = {
  review: {
    estimated_effort_to_review: number;
    score: number;
    has_relevant_tests: boolean;
    security_concerns: string;
  };
  comments: AIComment[];
};

type PullRequestReviewPrompt = {
  prTitle: string;
  prDescription: string;
  prSummary: string;
  files: FileDiff[];
};

export async function runReviewPrompt(
  pr: PullRequestReviewPrompt
): Promise<PullRequestReview> {


  let systemPrompt = `
<INSTRUCCIONES IMPORTANTES>
Eres un ingeniero de software senior experimentado encargado de revisar un Pull Request (PR) de Git. Tu objetivo es proporcionar comentarios para mejorar la calidad del código, detectar errores tipográficos, posibles errores o problemas de seguridad, y ofrecer sugerencias de código significativas cuando corresponda. No debes hacer comentarios sobre agregar comentarios, formato de código, estilo de código ni sugerencias de implementación.

La revisión debe centrarse en el nuevo código agregado en el diff del PR (líneas que comienzan con '+') y debe ser accionable.

El diff del PR tendrá la siguiente estructura:
======
## File: 'src/file1.py'

@@ ... @@ def func1():
__new hunk__
11  línea de código sin cambio 0 en el PR
12  línea de código sin cambio 1 en el PR
13 +nueva línea de código 2 agregada en el PR
14  línea de código sin cambio 3 en el PR
__old hunk__
 línea de código sin cambio 0
 línea de código sin cambio 1
-línea de código antigua 2 eliminada en el PR
 línea de código sin cambio 3
 __existing_comment_thread__
 presubmitai: Este es un comentario sobre el código
 user2: Esta es una respuesta al comentario anterior
 __existing_comment_thread__
 presubmitai: Este es un comentario sobre otras partes del código
 user2: Esta es una respuesta al comentario anterior

@@ ... @@ def func2():
__new hunk__
 línea de código sin cambio 4
+nueva línea de código 5 eliminada en el PR
 línea de código sin cambio 6

## File: 'src/file2.py'
...
======

- En el formato anterior, el diff está organizado en secciones separadas de '__new hunk__' y '__old hunk__' para cada bloque de código. '__new hunk__' contiene el código actualizado, mientras que '__old hunk__' muestra el código eliminado. Si no se eliminó código en un bloque específico, la sección __old hunk__ se omitirá.
- También agregamos números de línea para el código de '__new hunk__', para ayudarte a referirte a las líneas de código en tus sugerencias. Estos números de línea no forman parte del código real y solo deben usarse como referencia.
- Las líneas de código están prefijadas con símbolos ('+', '-', ' '). El símbolo '+' indica nuevo código agregado en el PR, el símbolo '-' indica código eliminado en el PR, y el símbolo ' ' indica código sin cambio. La revisión debe abordar el nuevo código agregado en el diff del PR (líneas que comienzan con '+')
- Usa formato markdown para tus comentarios.
- No devuelvas comentarios que sean incluso ligeramente similares a otros comentarios existentes para los mismos diffs de hunk.
- Si no puedes encontrar ningún comentario accionable, devuelve un array vacío.
- MUY IMPORTANTE: Ten en cuenta que solo estás viendo parte del código, y el código podría estar incompleto. No hagas suposiciones sobre el código fuera del diff.

${config.styleGuideRules && config.styleGuideRules.length > 0
      ? `Pautas para la revisión, como guías de estilo, convenciones o mejores prácticas, la violación de las siguientes pautas debe resultar en un comentario crítico:
${config.styleGuideRules}`
      : ''}
</INSTRUCCIONES IMPORTANTES>

<EJEMPLO>
{
    "review": {
    ...
    }
    "comments": [
    {
        content: "Hay un error tipográfico en "upgorading" que debería ser "upgrading".",
        header: "Corregir error tipográfico en el mensaje de error.",
        label: "typo",
        critical: false,
        highlighted_code: "      No active plan. Enable code reviews by upgorading to a Pro plan",
        ...
    },
    {
        content: "La variable 'user_id' se usa antes de estar definida. Considera mover la llamada a la función al final del archivo.",
        header: "Posible error en tiempo de ejecución en el código.",
        label: "bug",
        critical: true,
        ...
    },
    ...
    ]
}
</EJEMPLO>
`;


  let userPrompt = `
<Título del PR>
${pr.prTitle}
</Título del PR>

<Descripción del PR>
${pr.prDescription}
</Descripción del PR>

<Resumen del PR>
${pr.prSummary}
</Resumen del PR>

<Diffs de Archivos del PR>
${pr.files.map((file) => generateFileCodeDiff(file)).join("\n\n")}
</Diffs de Archivos del PR>
`;

  const commentSchema = z.object({
    file: z
      .string()
      .default("")
      .describe("The full file path of the relevant file"),
    start_line: z
      .number()
      .default(0)
      .describe(
        "The relevant line number, from a '__new hunk__' section, where the comment starts (inclusive). Should correspond to the prefix of the first line in the 'highlighted_code' snippet. If comment spans a single line, it should equal the 'end_line'"
      ),
    end_line: z
      .number()
      .default(0)
      .describe(
        "The relevant line number, from a '__new hunk__' section, where the comment ends (inclusive). Should correspond to the prefix of the last line in the 'highlighted_code' snippet. If comment spans a single line, it should equal the 'start_line'"
      ),
    content: z
      .string()
      .default("")
      .describe(
        "An actionable comment to enhance, improve or fix the new code introduced in the PR. Use markdown formatting."
      ),
    header: z
      .string()
      .default("")
      .describe(
        "A concise, single-sentence overview of the comment. Focus on the 'what'. Be general, and avoid method or variable names."
      ),
    highlighted_code: z
      .string()
      .default("")
      .describe(
        "A short code snippet from a '__new hunk__' section that the comment is applicable for.Include only complete code lines, without line numbers. This snippet should represent the full specific PR code targeted for comment, at its first line should match 'startLine' and last line match 'endLine'. If the code snippet is a single line, that line should match both 'startLine' and 'endLine'"
      ),
    label: z
      .string()
      .default("")
      .describe(
        "A single, descriptive label that best characterizes the suggestion type. Possible labels include 'security', 'possible bug', 'possible issue', 'performance', 'enhancement', 'best practice', 'maintainability', 'readability'. Other relevant labels are also acceptable."
      ),
    critical: z
      .boolean()
      .default(false)
      .describe(
        "True if the comment is critical and the PR should not be merged without addressing the comment. False otherwise."
      ),
  });

  const reviewSchema = z.object({
    estimated_effort_to_review: z
      .number()
      .min(1)
      .max(5)
      .default(3)
      .describe(
        "Estimate, on a scale of 1-5 (inclusive), the time and effort required to review this PR by an experienced and knowledgeable developer. 1 means short and easy review , 5 means long and hard review. Take into account the size, complexity, quality, and the needed changes of the PR code diff."
      ),
    score: z
      .number()
      .min(0)
      .max(100)
      .default(50)
      .describe(
        "Rate this PR on a scale of 0-100 (inclusive), where 0 means the worst possible PR code, and 100 means PR code of the highest quality, without any bugs or performance issues, that is ready to be merged immediately and run in production at scale."
      ),
    has_relevant_tests: z
      .boolean()
      .default(false)
      .describe(
        "True if the PR includes relevant tests added or updated. False otherwise."
      ),
    security_concerns: z
      .string()
      .default("No")
      .describe(
        "Does this PR code introduce possible vulnerabilities such as exposure of sensitive information (e.g., API keys, secrets, passwords), or security concerns like SQL injection, XSS, CSRF, and others ? Answer 'No' (without explaining why) if there are no possible issues. If there are security concerns or issues, start your answer with a short header, such as: 'Sensitive information exposure: ...', 'SQL injection: ...' etc. Explain your answer. Be specific and give examples if possible"
      ),
  });

  let schema = z.object({
    review: reviewSchema.describe("The full review of the PR"),
    comments: z
      .array(commentSchema)
      .describe(
        "Comments about possible bugs, security concerns, code quality, typos or regressions introduced in this PR."
      ),
  });

  const raw = await runPrompt({
    prompt: userPrompt,
    systemPrompt,
    schema,
  });

  // Filter out comments that are missing critical fields (can't be posted to GitHub)
  const review = raw as PullRequestReview;
  review.comments = review.comments.filter(
    (c) =>
      c.file &&
      c.file.length > 0 &&
      c.start_line > 0 &&
      c.end_line > 0 &&
      c.content &&
      c.content.length > 0
  );

  return review;
}

type ReviewCommentPrompt = {
  commentThread: ReviewCommentThread;
  commentFileDiff: FileDiff;
};

export type ReviewCommentResponse = {
  response_comment: string;
  action_requested: boolean;
};

export async function runReviewCommentPrompt({
  commentThread,
  commentFileDiff,
}: ReviewCommentPrompt): Promise<ReviewCommentResponse> {
  let systemPrompt = `Eres un ingeniero de software senior que revisa comentarios en Pull Requests (PRs) de Git. Tu tarea es proporcionar una respuesta a un comentario en la revisión de un PR. El comentario podría ser parte de un hilo de comentarios más largo, así que asegúrate de responder al comentario específico y no a todo el hilo.

El hilo de comentarios es específico de una línea o múltiples líneas de código en un archivo específico. Ten eso en cuenta al escribir tu respuesta, pero no asumas que el código es completo o correcto. Además, el comentario podría solicitarte que sugieras algunos cambios o mejoras fuera del fragmento de código, así que juzga en consecuencia.

En tu respuesta, devuelve el texto exacto de tu comentario, en markdown, comenzando por mencionar al @user que hizo el comentario. Tu respuesta se usará como un comentario en el PR, así que asegúrate de que sea fácil de entender y accionable.

Los comentarios de @presubmit son tuyos.

IMPORTANTE: No respondas con comentarios genéricos como "¡Gracias por el PR!" o "LGTM" o "Avísame si necesitas ayuda". Si el comentario de entrada no es accionable, devuelve una cadena vacía. No ofrezcas ayuda a menos que se te pida.
`;

  const startLine =
    commentThread.comments[0].start_line || commentThread.comments[0].line;
  const endLine = commentThread.comments[0].line;


  let userPrompt = `
A continuación verás el hilo completo de comentarios, pero debes enfocarte específicamente en el último comentario.
<Hilo de Comentarios>
${commentThread.comments
      .map(
        (comment) =>
          `<author>@${comment.user.login}</author>\n<comment>${comment.body}</comment>`
      )
      .join("\n")}
</Hilo de Comentarios>

<Alcance del Comentario>
  <Líneas>${startLine} - ${endLine}</Líneas>
  <Hunk>
    ${commentThread.comments[0].diff_hunk}
  </Hunk>
</Alcance del Comentario>

<Diff del Archivo del Comentario>
${generateFileCodeDiff(commentFileDiff)}
</Diff del Archivo del Comentario>
`;

  const schema = z.object({
    response_comment: z
      .string()
      .default("")
      .describe(
        "Your response to the comment in markdown format, starting by mentioning the user"
      ),
    action_requested: z
      .boolean()
      .default(false)
      .describe(
        "True if the input comment required an action from you. False otherwise."
      ),
  });

  return (await runPrompt({
    prompt: userPrompt,
    systemPrompt,
    schema,
  })) as ReviewCommentResponse;
}
