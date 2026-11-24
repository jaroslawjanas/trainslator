import { ActionIcon, Tooltip } from "@mantine/core";
import { useLocalStorage } from "@mantine/hooks";
import { IconTextDecrease, IconTextIncrease } from "@tabler/icons-react";
import { useEffect } from "react";

// Book text in pixels. 17 is the default the stylesheet sets.
const SIZES = [15, 17, 19, 21];

/**
 * Smaller and larger book text, for every place the original and a
 * translation are read side by side. The choice is remembered and shared
 * by Translation, Review and the reference-pair reader.
 */
export function TextSize() {
  const [size, setSize] = useLocalStorage({ key: "tr-book-size", defaultValue: 17 });
  useEffect(() => {
    document.documentElement.style.setProperty("--tr-book-size", `${size / 16}rem`);
  }, [size]);
  const at = Math.max(0, SIZES.indexOf(size));
  return (
    <ActionIcon.Group>
      <Tooltip label="Smaller text">
        <ActionIcon
          variant="default"
          aria-label="Smaller text"
          disabled={at === 0}
          onClick={() => setSize(SIZES[at - 1] ?? 17)}
        >
          <IconTextDecrease size={16} stroke={1.6} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label="Larger text">
        <ActionIcon
          variant="default"
          aria-label="Larger text"
          disabled={at === SIZES.length - 1}
          onClick={() => setSize(SIZES[at + 1] ?? 17)}
        >
          <IconTextIncrease size={16} stroke={1.6} />
        </ActionIcon>
      </Tooltip>
    </ActionIcon.Group>
  );
}
