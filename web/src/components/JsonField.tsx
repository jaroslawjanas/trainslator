import { Textarea } from "@mantine/core";
import { useEffect, useState } from "react";

/** Edits a JSON object (or null when empty) with validation. */
export function JsonField({
  label,
  description,
  value,
  onChange,
  minRows = 2,
}: {
  label: string;
  description?: string;
  value: Record<string, unknown> | null;
  onChange: (value: Record<string, unknown> | null, valid: boolean) => void;
  minRows?: number;
}) {
  const [text, setText] = useState(() => (value ? JSON.stringify(value, null, 2) : ""));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(value ? JSON.stringify(value, null, 2) : "");
    // Only reset when the value identity changes from outside.
  }, [value]);
  return (
    <Textarea
      label={label}
      description={description}
      value={text}
      error={error}
      autosize
      minRows={minRows}
      maxRows={12}
      classNames={{ input: "mono" }}
      onChange={(e) => {
        const next = e.currentTarget.value;
        setText(next);
        if (!next.trim()) {
          setError(null);
          onChange(null, true);
          return;
        }
        try {
          const parsed = JSON.parse(next);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
            throw new Error("Must be a JSON object");
          setError(null);
          onChange(parsed, true);
        } catch (e) {
          setError((e as Error).message);
          onChange(null, false);
        }
      }}
    />
  );
}

export function newClientId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}
