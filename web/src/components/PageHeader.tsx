import { Box, Collapse, Group, Text, Title, UnstyledButton } from "@mantine/core";
import { type ReactNode, useState } from "react";
import { Link } from "react-router";

/**
 * The id of the place beside the page title where a page puts its one-line
 * status (a finished run, the size of a knowledge base) with a Portal.
 */
export const HEADER_STATUS = "tr-header-status";

/**
 * The top of every page: where you are (a small link back to the book,
 * pair or project), the page title in the book face, one sentence on
 * what the page is for, and the page's status and actions.
 */
export function PageHeader({
  context,
  contextTo,
  title,
  description,
  about,
  actions,
}: {
  context?: ReactNode;
  contextTo?: string;
  title: ReactNode;
  description?: ReactNode;
  /**
   * Keeps the description behind "About this page", open or closed to
   * start with. Left out, the description always shows.
   */
  about?: boolean;
  actions?: ReactNode;
}) {
  const collapsible = about !== undefined && Boolean(description);
  const [open, setOpen] = useState(about ?? true);
  return (
    <Box className="tr-page-header">
      <Group justify="space-between" align="flex-end" wrap="wrap" gap="md">
        <Box style={{ minWidth: 0 }}>
          {context &&
            (contextTo ? (
              <Link to={contextTo} className="tr-context">
                {context}
              </Link>
            ) : (
              <Text className="tr-context">{context}</Text>
            ))}
          <Group gap="md" align="baseline" wrap="nowrap" mt={context ? 2 : 0}>
            <Title order={2}>{title}</Title>
            {collapsible && (
              <UnstyledButton
                className="tr-about"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
              >
                About this page
              </UnstyledButton>
            )}
          </Group>
        </Box>
        <Group gap="xs" wrap="nowrap" justify="flex-end" style={{ flex: "1 1 320px", minWidth: 0 }}>
          <div id={HEADER_STATUS} className="tr-header-status" />
          {actions && (
            <Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
              {actions}
            </Group>
          )}
        </Group>
      </Group>
      {description &&
        (collapsible ? (
          <Collapse expanded={open}>
            <Text size="md" c="dimmed" pt={8} maw={720}>
              {description}
            </Text>
          </Collapse>
        ) : (
          <Text size="md" c="dimmed" mt={6} maw={720}>
            {description}
          </Text>
        ))}
    </Box>
  );
}

/** A section inside a page: a smaller serif heading with an optional sentence. */
export function Section({
  title,
  description,
  actions,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Box component="section" mb={40}>
      <Group justify="space-between" align="flex-end" mb="sm" gap="md">
        <Box style={{ flex: "1 1 360px", minWidth: 0 }}>
          <Title order={3}>{title}</Title>
          {description && (
            <Text size="sm" c="dimmed" mt={4} maw={720}>
              {description}
            </Text>
          )}
        </Box>
        {actions && <Group gap="xs">{actions}</Group>}
      </Group>
      {children}
    </Box>
  );
}
