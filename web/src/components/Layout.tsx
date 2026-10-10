import {
  ActionIcon,
  AppShell,
  Box,
  Burger,
  Group,
  ScrollArea,
  Stack,
  Text,
  Tooltip,
  useComputedColorScheme,
  useMantineColorScheme,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconBooks, IconMoon, IconSettings, IconSun } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useMatches } from "react-router";
import { get } from "../api/client.ts";
import { useLiveEvents } from "../api/live.ts";
import type { Book, Pair } from "../api/types.ts";
import { displayTitle } from "../lib/format.ts";
import { BOOK_STAGES, PAIR_STAGES, type StageDef } from "../lib/stages.ts";
import { useProject } from "../pages/ProjectPage.tsx";
import { ActivityButton, useJobs } from "./JobsIndicator.tsx";
import { StageMark } from "./StageMark.tsx";

const WideContext = createContext<(wide: boolean) => void>(() => {});

/**
 * Lets a page use the whole width of the window instead of the usual
 * reading width, e.g. Review with several versions side by side.
 */
export function useWidePage(wide: boolean): void {
  const setWide = useContext(WideContext);
  useEffect(() => {
    setWide(wide);
    return () => setWide(false);
  }, [wide, setWide]);
}

/** Two facing pages, slightly open: the app's mark. */
export function BookMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size * 0.78} viewBox="0 0 28 22" aria-hidden="true">
      <path d="M14 4 C10 1.5 5 1 1 2 V19 C5 18 10 18.5 14 21 Z" fill="var(--tr-bookcloth)" />
      <path
        d="M14 4 C18 1.5 23 1 27 2 V19 C23 18 18 18.5 14 21 Z"
        fill="var(--tr-bookcloth)"
        opacity="0.55"
      />
    </svg>
  );
}

function useRouteParams(): Record<string, string | undefined> {
  const matches = useMatches();
  return Object.assign({}, ...matches.map((m) => m.params));
}

function NavItem({
  to,
  children,
  depth = 0,
  end = false,
  left,
  className,
  onNavigate,
}: {
  to: string;
  children: ReactNode;
  depth?: number;
  end?: boolean;
  left?: ReactNode;
  className?: string;
  onNavigate?: () => void;
}) {
  return (
    // NavLink sets aria-current="page" on the active item; the CSS hangs the ribbon on it.
    <NavLink
      to={to}
      end={end}
      onClick={onNavigate}
      className={`tr-nav-link ${className ?? ""}`}
      data-depth={depth}
    >
      {left}
      <span className="tr-nav-text">{children}</span>
    </NavLink>
  );
}

function StageList({
  base,
  stages,
  ctx,
  onNavigate,
}: {
  base: string;
  stages: StageDef[];
  ctx: Parameters<StageDef["mark"]>[0];
  onNavigate: () => void;
}) {
  return (
    <>
      {stages.map((s) => (
        <NavItem
          key={s.key}
          to={`${base}/${s.key}`}
          depth={2}
          left={<StageMark state={s.mark(ctx)} />}
          onNavigate={onNavigate}
        >
          {s.label}
        </NavItem>
      ))}
    </>
  );
}

function ProjectNav({
  pid,
  pairId,
  bookId,
  onNavigate,
}: {
  pid: string;
  pairId?: string;
  bookId?: string;
  onNavigate: () => void;
}) {
  const project = useProject(pid);
  const jobs = useJobs().data?.jobs ?? [];
  const pairDetail = useQuery({
    queryKey: ["pair", pairId],
    queryFn: () => get<{ alignment: { status: string } }>(`/api/projects/${pid}/pairs/${pairId}`),
    enabled: Boolean(pairId),
  });
  if (!project.data) return null;
  const { project: p, pairs, books } = project.data;
  const base = `/projects/${pid}`;
  const pairItem = (pair: Pair) => (
    <Box key={pair.id}>
      <NavItem
        to={`${base}/pairs/${pair.id}`}
        depth={1}
        className="tr-nav-book"
        onNavigate={onNavigate}
        end
      >
        {displayTitle(pair.title)}
      </NavItem>
      {pair.id === pairId && (
        <StageList
          base={`${base}/pairs/${pair.id}`}
          stages={PAIR_STAGES}
          ctx={{
            pair,
            alignmentConfirmed: pairDetail.data?.alignment.status === "confirmed",
            jobs,
          }}
          onNavigate={onNavigate}
        />
      )}
    </Box>
  );
  const bookItem = (book: Book) => (
    <Box key={book.id}>
      <NavItem
        to={`${base}/books/${book.id}`}
        depth={1}
        className="tr-nav-book"
        onNavigate={onNavigate}
        end
      >
        {displayTitle(book.title)}
      </NavItem>
      {book.id === bookId && (
        <StageList
          base={`${base}/books/${book.id}`}
          stages={BOOK_STAGES}
          ctx={{ book, jobs }}
          onNavigate={onNavigate}
        />
      )}
    </Box>
  );
  return (
    <Stack gap={0}>
      <Box className="tr-nav-project" mt="lg">
        <Text fw={600} className="serif" size="lg" lineClamp={2}>
          {p.name}
        </Text>
        <Text size="xs" c="dimmed">
          English into {p.targetLangName}
        </Text>
      </Box>
      <Stack gap={1} mt="xs">
        <NavItem to={base} end onNavigate={onNavigate}>
          Books and pairs
        </NavItem>
        <NavItem to={`${base}/notes`} onNavigate={onNavigate}>
          Language notes
        </NavItem>
        <NavItem to={`${base}/usage`} onNavigate={onNavigate}>
          Usage
        </NavItem>
        <NavItem to={`${base}/options`} onNavigate={onNavigate}>
          Project settings
        </NavItem>
      </Stack>
      {books.length > 0 && (
        <>
          <div className="tr-nav-label">Books</div>
          <Stack gap={1}>{books.map(bookItem)}</Stack>
        </>
      )}
      {pairs.length > 0 && (
        <>
          <div className="tr-nav-label">Reference pairs</div>
          <Stack gap={1}>{pairs.map(pairItem)}</Stack>
        </>
      )}
    </Stack>
  );
}

function SchemeToggle() {
  const { setColorScheme } = useMantineColorScheme();
  const scheme = useComputedColorScheme("light");
  return (
    <Tooltip label={scheme === "dark" ? "Light mode" : "Dark mode"}>
      <ActionIcon
        variant="subtle"
        color="gray"
        aria-label="Switch light or dark mode"
        onClick={() => setColorScheme(scheme === "dark" ? "light" : "dark")}
      >
        {scheme === "dark" ? (
          <IconSun size={17} stroke={1.6} />
        ) : (
          <IconMoon size={17} stroke={1.6} />
        )}
      </ActionIcon>
    </Tooltip>
  );
}

export function Layout() {
  useLiveEvents();
  const [opened, { toggle, close }] = useDisclosure(false);
  const [wide, setWide] = useState(false);
  const params = useRouteParams();
  const location = useLocation();
  // biome-ignore lint/correctness/useExhaustiveDependencies: close the mobile menu on navigation
  useEffect(() => close(), [location.pathname]);

  return (
    <AppShell
      header={{ height: { base: 52, sm: 0 } }}
      navbar={{ width: 272, breakpoint: "sm", collapsed: { mobile: !opened } }}
      padding={0}
    >
      <AppShell.Header hiddenFrom="sm" className="tr-nav">
        <Group h="100%" px="md" justify="space-between">
          <Link to="/projects" className="tr-wordmark">
            <BookMark />
            Trainslator
          </Link>
          <Burger opened={opened} onClick={toggle} size="sm" aria-label="Menu" />
        </Group>
      </AppShell.Header>
      <AppShell.Navbar className="tr-nav" p="sm">
        <AppShell.Section visibleFrom="sm" px={6} pt={6} pb="md">
          <Link to="/projects" className="tr-wordmark">
            <BookMark />
            Trainslator
          </Link>
        </AppShell.Section>
        <AppShell.Section grow component={ScrollArea} scrollbarSize={6}>
          <NavItem
            to="/projects"
            end
            left={<IconBooks size={16} stroke={1.6} />}
            onNavigate={close}
          >
            All projects
          </NavItem>
          {params.pid && (
            <ProjectNav
              pid={params.pid}
              pairId={params.pairId}
              bookId={params.bookId}
              onNavigate={close}
            />
          )}
        </AppShell.Section>
        <AppShell.Section pt="sm" style={{ borderTop: "1px solid var(--tr-rule)" }}>
          <Stack gap={1}>
            <ActivityButton />
            <Group gap={0} justify="space-between" wrap="nowrap">
              <Box style={{ flex: 1 }}>
                <NavItem
                  to="/settings"
                  left={<IconSettings size={16} stroke={1.6} />}
                  onNavigate={close}
                >
                  Settings
                </NavItem>
              </Box>
              <SchemeToggle />
            </Group>
          </Stack>
        </AppShell.Section>
      </AppShell.Navbar>
      <AppShell.Main>
        <Box px={{ base: "md", sm: 40 }} pb={64} maw={wide ? undefined : 1440}>
          <WideContext.Provider value={setWide}>
            <Outlet />
          </WideContext.Provider>
        </Box>
      </AppShell.Main>
    </AppShell>
  );
}
