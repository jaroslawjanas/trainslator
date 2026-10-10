import { Box, Group, Text, Title } from "@mantine/core";
import type { ReactNode } from "react";
import { Link } from "react-router";

/**
 * The top of every page: where you are (a small link back to the book,
 * pair or project), the page title in the book face, one sentence on
 * what the page is for, and the page's actions.
 */
export function PageHeader({
  context,
  contextTo,
  title,
  description,
  actions,
}: {
  context?: ReactNode;
  contextTo?: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <Box className="tr-page-header">
      <Group justify="space-between" align="flex-end" wrap="wrap" gap="md">
        <Box style={{ flex: "1 1 420px", minWidth: 0 }}>
          {context &&
            (contextTo ? (
              <Link to={contextTo} className="tr-context">
                {context}
              </Link>
            ) : (
              <Text className="tr-context">{context}</Text>
            ))}
          <Title order={2} mt={context ? 4 : 0}>
            {title}
          </Title>
          {description && (
            <Text size="md" c="dimmed" mt={6} maw={680}>
              {description}
            </Text>
          )}
        </Box>
        {actions && (
          <Group gap="xs" wrap="nowrap">
            {actions}
          </Group>
        )}
      </Group>
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
            <Text size="sm" c="dimmed" mt={4} maw={680}>
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
