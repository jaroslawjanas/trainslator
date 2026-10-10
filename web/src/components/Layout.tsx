import { AppShell, Badge, Container, Group, Text, UnstyledButton } from "@mantine/core";
import { NavLink, Outlet } from "react-router";
import { useLiveEvents } from "../api/live.ts";
import { JobsIndicator } from "./JobsIndicator.tsx";

function TopLink({ to, children }: { to: string; children: string }) {
  return (
    <NavLink to={to} style={{ textDecoration: "none" }}>
      {({ isActive }) => (
        <UnstyledButton
          px="sm"
          py={6}
          style={{ borderRadius: 6 }}
          bg={isActive ? "var(--mantine-color-default-hover)" : undefined}
        >
          <Text fw={isActive ? 600 : 400} size="sm">
            {children}
          </Text>
        </UnstyledButton>
      )}
    </NavLink>
  );
}

export function Layout() {
  useLiveEvents();
  return (
    <AppShell header={{ height: 56 }} padding="md">
      <AppShell.Header>
        <Container size="xl" h="100%">
          <Group h="100%" justify="space-between">
            <Group gap="lg">
              <Group gap={6}>
                <Text fw={700} size="lg">
                  Trainslator
                </Text>
                <Badge variant="light" size="xs">
                  local
                </Badge>
              </Group>
              <Group gap={4}>
                <TopLink to="/projects">Projects</TopLink>
                <TopLink to="/settings">Settings</TopLink>
              </Group>
            </Group>
            <JobsIndicator />
          </Group>
        </Container>
      </AppShell.Header>
      <AppShell.Main>
        <Container size="xl">
          <Outlet />
        </Container>
      </AppShell.Main>
    </AppShell>
  );
}
