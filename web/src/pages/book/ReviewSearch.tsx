import {
  ActionIcon,
  Button,
  Checkbox,
  CloseButton,
  Group,
  Loader,
  SegmentedControl,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconReplace, IconSearch } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { type RefObject, useEffect, useState } from "react";
import { get, post } from "../../api/client.ts";
import { displayTitle, plural } from "../../lib/format.ts";

export interface SearchResult {
  chapterId: string;
  chapterTitle: string;
  key: string;
  /** "source" for the original, else the version's id. */
  version: string;
  /** How often the text occurs in this passage. */
  matches: number;
  before: string;
  match: string;
  after: string;
}

export type SearchScope = "chapter" | "book";

/** What a replacement changed (or, counted first, would change). */
interface Replaced {
  passages: number;
  replaced: number;
  skipped: number;
}

const SOURCE = "source";

/** Shortest search that is sent. */
export const MIN_QUERY = 2;

/**
 * Search in Review: the text, where to look (this chapter or the whole book)
 * and in which of the open columns, and the passages found. Enter goes to the
 * next result, Shift+Enter to the previous one.
 */
export function ReviewSearch({
  pid,
  bookId,
  chapterId,
  columns,
  query,
  onQuery,
  debounced,
  scope,
  onScope,
  searched,
  onSearched,
  exact,
  onExact,
  wholeWord,
  onWholeWord,
  inputRef,
  onPick,
  onReplaced,
  onClose,
}: {
  pid: string;
  bookId: string;
  chapterId: string | null;
  columns: { id: string; label: string }[];
  query: string;
  onQuery: (q: string) => void;
  /** The query after typing has paused; this is what is searched. */
  debounced: string;
  scope: SearchScope;
  onScope: (s: SearchScope) => void;
  searched: string[];
  onSearched: (ids: string[]) => void;
  /** Case and accents must match. */
  exact: boolean;
  onExact: (on: boolean) => void;
  wholeWord: boolean;
  onWholeWord: (on: boolean) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  onPick: (r: SearchResult) => void;
  /** Something was replaced: the page reloads what it shows. */
  onReplaced: () => void;
  onClose: () => void;
}) {
  const text = debounced.trim();
  const [replacing, setReplacing] = useState(false);
  const [replacement, setReplacement] = useState("");
  const [busy, setBusy] = useState(false);
  /** After replacing in one passage, go on to the result now at the same place. */
  const [advance, setAdvance] = useState<number | null>(null);
  const enabled = text.length >= MIN_QUERY && searched.length > 0;
  const results = useQuery({
    queryKey: [
      "target",
      bookId,
      "review-search",
      text,
      searched.join(","),
      scope === "chapter" ? chapterId : null,
      exact,
      wholeWord,
    ],
    enabled,
    placeholderData: (previous) => previous,
    queryFn: () =>
      get<{ results: SearchResult[]; total: number }>(
        `/api/projects/${pid}/books/${bookId}/review/search?q=${encodeURIComponent(text)}&versions=${searched.join(",")}${scope === "chapter" && chapterId ? `&chapter=${chapterId}` : ""}${exact ? "&exact=1" : ""}${wholeWord ? "&words=1" : ""}`,
      ),
  });
  const list = enabled ? (results.data?.results ?? []) : [];
  const total = enabled ? (results.data?.total ?? 0) : 0;
  const [active, setActive] = useState(-1);
  // Start over when the search changes. Moving to another chapter changes the
  // results only when searching one chapter.
  // biome-ignore lint/correctness/useExhaustiveDependencies: those are the search's inputs
  useEffect(
    () => setActive(-1),
    [text, scope, searched.join(","), scope === "chapter" ? chapterId : null, exact, wholeWord],
  );
  useEffect(() => {
    if (active >= 0)
      document
        .querySelector(".tr-search-result[data-active]")
        ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const step = (by: number) => {
    if (list.length === 0) return;
    const next = (active + by + list.length) % list.length;
    setActive(next);
    onPick(list[next]!);
  };
  const labelOf = (id: string) => columns.find((c) => c.id === id)?.label ?? id;

  // Once the results are fresh after a replacement, go on to the next one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the new results arrive
  useEffect(() => {
    if (advance === null || results.isFetching) return;
    const i = Math.min(advance, list.length - 1);
    setAdvance(null);
    if (i < 0) return;
    setActive(i);
    onPick(list[i]!);
  }, [results.data, results.isFetching]);

  const translations = searched.filter((v) => v !== SOURCE);
  const send = (body: Record<string, unknown>) =>
    post<Replaced>(`/api/projects/${pid}/books/${bookId}/review/replace`, {
      query: text,
      replacement,
      exact,
      wholeWord,
      ...body,
    });
  const failed = (e: unknown) =>
    notifications.show({ color: "red", title: "Couldn't replace", message: (e as Error).message });

  /** Replaces in the selected result's passage, then goes on; without one, selects the next. */
  const replaceOne = async () => {
    const current = active >= 0 ? list[active] : undefined;
    if (!current || current.version === SOURCE) {
      for (let k = 1; k <= list.length; k++) {
        const i = (active + k + list.length) % list.length;
        if (list[i]!.version !== SOURCE) {
          setActive(i);
          onPick(list[i]!);
          return;
        }
      }
      return;
    }
    setBusy(true);
    try {
      const done = await send({ versions: [current.version], key: current.key });
      if (done.skipped > 0)
        notifications.show({
          message: `${plural(done.skipped, "match", "matches")} crossing formatting left as they are.`,
        });
      setAdvance(active);
      onReplaced();
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };

  const replaceAll = async () => {
    setBusy(true);
    try {
      const where = { versions: translations, chapterId: scope === "chapter" ? chapterId : null };
      const counted = await send({ ...where, dryRun: true });
      if (counted.replaced === 0) {
        notifications.show({
          message:
            counted.skipped > 0
              ? "Every match crosses formatting, so nothing can be replaced."
              : "Nothing to replace.",
        });
        return;
      }
      const names = translations.map(labelOf).join(" and ");
      const notes = [
        translations.includes("current")
          ? "The current translation is saved in History first, so you can undo this by restoring it."
          : null,
        translations.some((v) => v !== "current")
          ? "Saved translations are changed as they are."
          : null,
        counted.skipped > 0
          ? `${plural(counted.skipped, "match", "matches")} crossing formatting will be left as they are.`
          : null,
      ].filter(Boolean);
      if (
        !window.confirm(
          `Replace "${text}" with "${replacement}" ${plural(counted.replaced, "time")} in ${plural(counted.passages, "passage")} of ${names}${scope === "chapter" ? ", in this chapter" : ", in the whole book"}?\n\n${notes.join("\n")}`,
        )
      )
        return;
      const done = await send(where);
      notifications.show({
        color: "green",
        message: `Replaced ${plural(done.replaced, "time")} in ${plural(done.passages, "passage")}.`,
      });
      onReplaced();
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };
  const status = !text
    ? exact
      ? "Type what to find."
      : "Type what to find. Case and accents don't matter."
    : text.length < MIN_QUERY
      ? `Type at least ${MIN_QUERY} letters.`
      : results.isPending
        ? "Searching…"
        : total === 0
          ? "Not found."
          : total > list.length
            ? `Found in ${plural(total, "passage")}; the first ${list.length} are listed.`
            : `Found in ${plural(total, "passage")}.`;

  return (
    <aside className="tr-search" aria-label="Search">
      <Group justify="space-between" wrap="nowrap" mb={6}>
        <Text size="sm" fw={600}>
          {replacing ? "Search and replace" : "Search"}
        </Text>
        <Group gap={4} wrap="nowrap">
          <Tooltip label={replacing ? "Hide replace" : "Replace"}>
            <ActionIcon
              variant={replacing ? "light" : "subtle"}
              color={replacing ? "bookcloth" : "gray"}
              size="sm"
              aria-label="Replace"
              aria-pressed={replacing}
              onClick={() => setReplacing((r) => !r)}
            >
              <IconReplace size={15} />
            </ActionIcon>
          </Tooltip>
          <CloseButton size="sm" aria-label="Close the search" onClick={onClose} />
        </Group>
      </Group>
      <TextInput
        ref={inputRef}
        aria-label="Find in the text"
        placeholder="Find in the text"
        value={query}
        onChange={(e) => onQuery(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        leftSection={<IconSearch size={14} />}
        rightSection={results.isFetching && enabled ? <Loader size={14} /> : null}
      />
      {replacing && (
        <>
          <TextInput
            mt="xs"
            aria-label="Replace with"
            placeholder="Replace with"
            value={replacement}
            onChange={(e) => setReplacement(e.currentTarget.value)}
            leftSection={<IconReplace size={14} />}
          />
          <Group gap="xs" mt="xs" grow>
            <Button
              size="xs"
              variant="default"
              loading={busy}
              disabled={!enabled || list.length === 0 || translations.length === 0}
              onClick={replaceOne}
            >
              Replace
            </Button>
            <Button
              size="xs"
              variant="default"
              loading={busy}
              disabled={!enabled || list.length === 0 || translations.length === 0}
              onClick={replaceAll}
            >
              Replace all
            </Button>
          </Group>
          <Text size="xs" c="dimmed" mt={4}>
            {translations.length === 0
              ? "Tick a translation to replace in."
              : `Replaces in ${translations.map(labelOf).join(" and ")}${searched.includes(SOURCE) ? `; the ${labelOf(SOURCE)} isn't changed` : ""}. Replace changes the selected result's passage and goes to the next.`}
          </Text>
        </>
      )}
      <SegmentedControl
        size="xs"
        fullWidth
        mt="xs"
        value={scope}
        onChange={(v) => onScope(v as SearchScope)}
        data={[
          { value: "chapter", label: "This chapter" },
          { value: "book", label: "Whole book" },
        ]}
      />
      <Group gap="md" mt="xs">
        <Checkbox
          size="xs"
          label="Match case and accents"
          checked={exact}
          onChange={(e) => onExact(e.currentTarget.checked)}
        />
        <Checkbox
          size="xs"
          label="Whole words"
          checked={wholeWord}
          onChange={(e) => onWholeWord(e.currentTarget.checked)}
        />
      </Group>
      <Group gap="md" mt="xs">
        {columns.map((c) => (
          <Checkbox
            key={c.id}
            size="xs"
            label={c.label}
            checked={searched.includes(c.id)}
            // At least one version stays searched.
            disabled={searched.length === 1 && searched.includes(c.id)}
            onChange={(e) =>
              onSearched(
                e.currentTarget.checked
                  ? columns.filter((x) => x.id === c.id || searched.includes(x.id)).map((x) => x.id)
                  : searched.filter((id) => id !== c.id),
              )
            }
          />
        ))}
      </Group>
      <Text size="xs" c="dimmed" mt="sm">
        {status}
        {list.length > 1 && " Enter goes to the next one, Shift+Enter to the previous."}
      </Text>
      <div className="tr-search-results">
        {list.map((r, i) => (
          <button
            key={`${r.key}:${r.version}`}
            type="button"
            className="tr-search-result"
            data-active={i === active || undefined}
            onClick={() => {
              setActive(i);
              onPick(r);
            }}
          >
            <div className="tr-search-where">
              {scope === "book" ? `${displayTitle(r.chapterTitle)}, ` : ""}
              {labelOf(r.version)}
              {r.matches > 1 ? `, ${r.matches} times` : ""}
            </div>
            <div className="tr-search-snippet">
              {r.before}
              <mark className="tr-hit">{r.match}</mark>
              {r.after}
            </div>
          </button>
        ))}
      </div>
    </aside>
  );
}
