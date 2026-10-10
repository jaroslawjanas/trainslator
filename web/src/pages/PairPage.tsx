import {
  Alert,
  Anchor,
  Badge,
  Breadcrumbs,
  Button,
  Group,
  Loader,
  Stack,
  Tabs,
  Text,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router";
import { del, get } from "../api/client.ts";
import { DiagnosticsList } from "../components/DiagnosticsList.tsx";
import { KbEditor } from "./kb/KbEditor.tsx";
import { useProject } from "./ProjectPage.tsx";
import { AlignmentPanel, type PairDetail } from "./pair/AlignmentPanel.tsx";
import { Phase1Panel } from "./pair/Phase1Panel.tsx";

export function PairPage() {
  const { pid = "", pairId = "" } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const project = useProject(pid);
  const { data, isLoading, error } = useQuery({
    queryKey: ["pair", pairId],
    queryFn: () => get<PairDetail>(`/api/projects/${pid}/pairs/${pairId}`),
  });
  if (isLoading) return <Loader />;
  if (error || !data)
    return <Alert color="red">{(error as Error)?.message ?? "Pair not found."}</Alert>;
  const diagnostics = [...data.source.diagnostics, ...data.target.diagnostics];

  return (
    <Stack>
      <Breadcrumbs>
        <Anchor component={Link} to="/projects">
          Projects
        </Anchor>
        <Anchor component={Link} to={`/projects/${pid}`}>
          {project.data?.project.name ?? "Project"}
        </Anchor>
        <Text>{data.pair.title}</Text>
      </Breadcrumbs>
      <Group justify="space-between">
        <div>
          <Title order={2}>{data.pair.title}</Title>
          <Text size="sm" c="dimmed">
            Reference pair · {data.pair.sourceFileName} ({data.source.totalWords.toLocaleString()}{" "}
            words) + {data.pair.targetFileName} ({data.target.totalWords.toLocaleString()} words)
          </Text>
        </div>
        <Group>
          <Badge variant="light" color={data.alignment.status === "confirmed" ? "green" : "yellow"}>
            alignment {data.alignment.status}
          </Badge>
          <Button
            variant="subtle"
            color="red"
            onClick={async () => {
              if (!window.confirm("Delete this reference pair and its knowledge base?")) return;
              try {
                await del(`/api/projects/${pid}/pairs/${pairId}`);
                await client.invalidateQueries({ queryKey: ["project", pid] });
                navigate(`/projects/${pid}`);
              } catch (e) {
                notifications.show({
                  color: "red",
                  title: "Couldn't delete",
                  message: (e as Error).message,
                });
              }
            }}
          >
            Delete pair
          </Button>
        </Group>
      </Group>
      {diagnostics.length > 0 && <DiagnosticsList diagnostics={diagnostics} />}
      <Tabs defaultValue="alignment" keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="alignment">1 · Chapter alignment</Tabs.Tab>
          <Tabs.Tab value="phase1" disabled={data.alignment.status !== "confirmed"}>
            2 · Phase 1
          </Tabs.Tab>
          <Tabs.Tab value="kb">3 · Knowledge base</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="alignment" pt="md">
          <AlignmentPanel pid={pid} detail={data} />
        </Tabs.Panel>
        <Tabs.Panel value="phase1" pt="md">
          <Phase1Panel pid={pid} pairId={pairId} />
        </Tabs.Panel>
        <Tabs.Panel value="kb" pt="md">
          <KbEditor pid={pid} scope="pair" targetId={pairId} />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
