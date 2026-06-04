"use client";

import { useState } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { saveRules } from "@/lib/actions/rules";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function ToolbarButton({
  editor,
  active,
  onClick,
  children,
}: {
  editor: Editor | null;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!editor}
      className={cn(
        "rounded px-2 py-1 text-sm",
        active ? "bg-secondary text-secondary-foreground" : "hover:bg-secondary/60",
      )}
    >
      {children}
    </button>
  );
}

export function RulesEditor({ initialContent }: { initialContent: unknown }) {
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const editor = useEditor({
    extensions: [StarterKit],
    content: (initialContent as object) ?? "",
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class:
          "min-h-64 rounded-b-md border border-t-0 p-4 focus:outline-none " +
          "[&_h1]:text-2xl [&_h1]:font-bold [&_h1]:mb-2 " +
          "[&_h2]:text-xl [&_h2]:font-semibold [&_h2]:mt-4 [&_h2]:mb-2 " +
          "[&_h3]:text-lg [&_h3]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1 " +
          "[&_p]:mb-2 [&_ul]:list-disc [&_ul]:ml-5 [&_ol]:list-decimal [&_ol]:ml-5",
      },
    },
  });

  async function onSave() {
    if (!editor) return;
    setSaving(true);
    setMessage("");
    const res = await saveRules(editor.getJSON());
    setSaving(false);
    setMessage(res?.ok ? "Saved." : res?.message ?? "Error saving.");
  }

  return (
    <div className="space-y-3">
      <div className="bg-muted/40 flex flex-wrap gap-1 rounded-t-md border p-1">
        <ToolbarButton
          editor={editor}
          active={!!editor?.isActive("bold")}
          onClick={() => editor?.chain().focus().toggleBold().run()}
        >
          <strong>B</strong>
        </ToolbarButton>
        <ToolbarButton
          editor={editor}
          active={!!editor?.isActive("italic")}
          onClick={() => editor?.chain().focus().toggleItalic().run()}
        >
          <em>I</em>
        </ToolbarButton>
        <ToolbarButton
          editor={editor}
          active={!!editor?.isActive("heading", { level: 2 })}
          onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
        >
          H2
        </ToolbarButton>
        <ToolbarButton
          editor={editor}
          active={!!editor?.isActive("heading", { level: 3 })}
          onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}
        >
          H3
        </ToolbarButton>
        <ToolbarButton
          editor={editor}
          active={!!editor?.isActive("bulletList")}
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
        >
          • List
        </ToolbarButton>
        <ToolbarButton
          editor={editor}
          active={!!editor?.isActive("orderedList")}
          onClick={() => editor?.chain().focus().toggleOrderedList().run()}
        >
          1. List
        </ToolbarButton>
      </div>

      <EditorContent editor={editor} />

      <div className="flex items-center gap-3">
        <Button onClick={onSave} disabled={saving}>
          {saving ? "Saving…" : "Save rules"}
        </Button>
        {message ? (
          <span className="text-muted-foreground text-sm">{message}</span>
        ) : null}
      </div>
    </div>
  );
}
