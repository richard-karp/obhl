import { Fragment } from "react";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Node = {
  type: string;
  content?: Node[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, any> }[];
  attrs?: Record<string, any>;
};

function renderText(node: Node, key: number): React.ReactNode {
  let el: React.ReactNode = node.text ?? "";
  for (const mark of node.marks ?? []) {
    if (mark.type === "bold") el = <strong>{el}</strong>;
    else if (mark.type === "italic") el = <em>{el}</em>;
    else if (mark.type === "code")
      el = <code className="bg-muted rounded px-1 py-0.5 text-sm">{el}</code>;
    else if (mark.type === "link" && mark.attrs?.href)
      el = (
        <a
          href={mark.attrs.href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline"
        >
          {el}
        </a>
      );
  }
  return <Fragment key={key}>{el}</Fragment>;
}

function renderNode(node: Node, key: number): React.ReactNode {
  const children = node.content?.map((c, i) => renderNode(c, i));
  switch (node.type) {
    case "heading": {
      const level = Math.min(Math.max(node.attrs?.level ?? 2, 1), 4);
      const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4";
      const cls =
        level <= 2
          ? "mt-8 mb-3 text-xl font-semibold tracking-tight first:mt-0"
          : "mt-6 mb-2 text-lg font-semibold";
      return (
        <Tag key={key} className={cls}>
          {children}
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p key={key} className="text-muted-foreground mb-3 leading-relaxed">
          {children}
        </p>
      );
    case "bulletList":
      return (
        <ul key={key} className="text-muted-foreground mb-4 ml-5 list-disc space-y-1">
          {children}
        </ul>
      );
    case "orderedList":
      return (
        <ol key={key} className="text-muted-foreground mb-4 ml-5 list-decimal space-y-1">
          {children}
        </ol>
      );
    case "listItem":
      return <li key={key}>{children}</li>;
    case "text":
      return renderText(node, key);
    case "hardBreak":
      return <br key={key} />;
    default:
      return <Fragment key={key}>{children}</Fragment>;
  }
}

/** Renders Tiptap/ProseMirror JSON read-only (no editor dependency). */
export function RulesRenderer({ content }: { content: unknown }) {
  const doc = content as Node | null;
  if (!doc || !doc.content) return null;
  return <div>{doc.content.map((n, i) => renderNode(n, i))}</div>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
