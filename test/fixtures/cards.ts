// Representative cards: what real views look like. Used by the golden tests
// (design lock) and as the fixture set for visual review — render them, look.

import { ViewSpecSchema, type ViewSnapshot, type ViewSpec } from "../../src/views/model.js";

const AT = "2026-08-21T15:42:07.000Z";

function spec(
  id: string,
  title: string,
  description: string,
  sensitivity: "private" | "shareable",
  intervalMs: number | null,
  tools: string[],
): ViewSpec {
  return ViewSpecSchema.parse({
    id,
    title,
    description,
    owner: "dvd",
    sensitivity,
    queries: tools.map((tool, index) => ({ key: `q${String(index)}`, tool, arguments: {} })),
    transform: "(input) => input",
    refresh: { intervalMs },
    createdAt: "2026-08-20T10:00:00.000Z",
    updatedAt: "2026-08-21T09:12:00.000Z",
  });
}

function ok(
  viewId: string,
  model: NonNullable<ViewSnapshot["model"]>,
  provenance: { key: string; capability: string; version: string }[],
  durationMs: number,
): ViewSnapshot {
  return {
    viewId,
    ok: true,
    model,
    provenance: provenance.map((entry) => ({ ...entry, ts: AT })),
    startedAt: AT,
    durationMs,
  };
}

export interface Fixture {
  spec: ViewSpec;
  snapshot: ViewSnapshot | undefined;
}

export const weeklyFitness: Fixture = {
  spec: spec("weekly-fitness", "Week in motion", "Training load, goals and recent sessions", "private", 900_000, [
    "fitness__get_workout_stats",
    "fitness__get_recent_workouts",
  ]),
  snapshot: ok(
    "weekly-fitness",
    {
      title: "Week in motion",
      subtitle: "Mon Aug 17 – Sun Aug 23 · metric",
      sections: [
        {
          kind: "stats",
          items: [
            { label: "Workouts", value: "4", delta: "+1", tone: "good", hint: "vs last week" },
            { label: "Distance", value: "32.4 km", delta: "+12%", tone: "good" },
            { label: "Active time", value: "3 h 48 m", delta: "−22 min", tone: "neutral" },
            { label: "Avg heart rate", value: "142 bpm", delta: "−3", tone: "good", hint: "lower is better here" },
          ],
        },
        {
          kind: "spark",
          title: "Daily distance",
          label: "last 14 days",
          unit: "km",
          points: [4.2, 0, 6.1, 5.0, 0, 8.3, 3.5, 0, 5.2, 7.4, 0, 6.0, 9.8, 4.1],
        },
        {
          kind: "bars",
          title: "Workouts by weekday",
          unit: "last 4 weeks",
          items: [
            { label: "Mon", value: 3 },
            { label: "Tue", value: 1 },
            { label: "Wed", value: 4 },
            { label: "Thu", value: 2 },
            { label: "Fri", value: 1 },
            { label: "Sat", value: 5 },
            { label: "Sun", value: 2 },
          ],
        },
        {
          kind: "progress",
          title: "Weekly goals",
          items: [
            { label: "Workouts", value: 4, max: 5, display: "4 of 5", tone: "good" },
            { label: "Distance", value: 32.4, max: 40, display: "32.4 / 40 km" },
            { label: "Long run", value: 9.8, max: 15, display: "9.8 / 15 km", tone: "warn" },
          ],
        },
        {
          kind: "table",
          title: "Recent workouts",
          columns: ["Date", "Type", { label: "Distance", align: "right" }, "Duration", "Pace"],
          rows: [
            ["Aug 21", "Run", "9.8 km", "52:10", "5:19 /km"],
            ["Aug 19", "Run", "6.0 km", "33:40", "5:37 /km"],
            ["Aug 18", "Strength", "—", "45:00", "—"],
            ["Aug 16", "Run", "7.4 km", "41:02", "5:33 /km"],
            ["Aug 15", "Ride", "5.2 km", "18:30", "—"],
          ],
        },
      ],
    },
    [
      { key: "q0", capability: "fitness", version: "0.2.0" },
      { key: "q1", capability: "fitness", version: "0.2.0" },
    ],
    38,
  ),
};

export const airAndSky: Fixture = {
  spec: spec("air-and-sky", "Air & sky", "Sensor air quality and the forecast for home", "shareable", 600_000, [
    "weather__get_current",
    "weather__get_forecast",
  ]),
  snapshot: ok(
    "air-and-sky",
    {
      title: "Air & sky — Alameda",
      subtitle: "PurpleAir sensor three blocks away · Open-Meteo forecast",
      sections: [
        {
          kind: "stats",
          items: [
            { label: "Air quality", value: "42", delta: "−6", tone: "good", hint: "Good · PM2.5 10.1 µg/m³" },
            { label: "Temperature", value: "68°F", delta: "+4° vs yesterday", tone: "neutral" },
            { label: "Humidity", value: "54%" },
            { label: "Wind", value: "9 mph", hint: "NW · gusts to 25 after 3 pm" },
          ],
        },
        {
          kind: "progress",
          title: "Air quality index",
          items: [{ label: "AQI 42", value: 42, max: 300, display: "Good", tone: "good" }],
        },
        {
          kind: "spark",
          title: "Next 24 hours",
          label: "temperature",
          unit: "°F",
          points: [61, 60, 59, 58, 58, 60, 63, 66, 69, 71, 72, 72, 71, 70, 68, 66, 64, 62, 61, 60, 59, 59, 58, 58],
        },
        {
          kind: "bars",
          title: "Rain chance",
          unit: "% per two-hour block",
          items: [
            { label: "12a", value: 5 },
            { label: "2a", value: 5 },
            { label: "4a", value: 10 },
            { label: "6a", value: 10 },
            { label: "8a", value: 5 },
            { label: "10a", value: 0 },
            { label: "12p", value: 0 },
            { label: "2p", value: 0 },
            { label: "4p", value: 5 },
            { label: "6p", value: 15 },
            { label: "8p", value: 20 },
            { label: "10p", value: 25 },
          ],
        },
        {
          kind: "list",
          title: "Today",
          items: [
            { text: "Good air through the evening", tone: "good" },
            { text: "Wind gusts to 25 mph after 3 pm", tone: "warn" },
            "Sunset 7:52 pm",
            "Tomorrow looks similar — AQI forecast 38",
          ],
        },
      ],
    },
    [
      { key: "q0", capability: "weather", version: "1.4.0" },
      { key: "q1", capability: "weather", version: "1.4.0" },
    ],
    112,
  ),
};

export const today: Fixture = {
  spec: spec("today", "Today", "Both calendars, conflicts, and what is next", "private", 300_000, [
    "calsync__get_agenda",
    "calsync__get_conflicts",
  ]),
  snapshot: ok(
    "today",
    {
      title: "Today",
      subtitle: "Friday, August 21 · personal + work",
      sections: [
        {
          kind: "stats",
          items: [
            { label: "Meetings", value: "5" },
            { label: "Focus time", value: "2 h 15 m", delta: "−45 min", tone: "bad", hint: "vs your weekday average" },
            { label: "Next up", value: "in 35 min", hint: "Design review · Room 4B" },
          ],
        },
        {
          kind: "table",
          title: "Schedule",
          columns: ["Time", "What", "Where"],
          rows: [
            ["9:00", "Standup", "Zoom"],
            ["10:30", "Design review", "Room 4B"],
            ["12:00", "Lunch with Sam", "Café Umami"],
            ["14:00", "1:1 Priya", "Zoom"],
            ["16:30", "Platform sync", "Room 2A"],
          ],
        },
        {
          kind: "list",
          title: "Heads up",
          items: [
            { text: "Design review overlaps 1:1 Priya by 15 min", tone: "bad" },
            { text: "Platform sync has no agenda yet", tone: "warn" },
          ],
        },
        {
          kind: "keyValues",
          title: "Calendars",
          items: [
            { key: "Personal", value: "3 events" },
            { key: "Work", value: "2 events" },
            { key: "Timezone", value: "America/Los_Angeles" },
          ],
        },
      ],
    },
    [
      { key: "q0", capability: "calsync", version: "0.9.2" },
      { key: "q1", capability: "calsync", version: "0.9.2" },
    ],
    64,
  ),
};

export const pantryBroken: Fixture = {
  spec: spec("pantry", "Pantry stock", "What is running low", "private", null, ["pantry__list_stock"]),
  snapshot: {
    viewId: "pantry",
    ok: false,
    error: { kind: "transform", message: "Cannot read properties of undefined (reading 'items')" },
    queryErrors: {
      q0: { code: "grant_missing", message: "view-pantry has no grant on capability:pantry for list_stock" },
    },
    startedAt: AT,
    durationMs: 3,
  },
};

export const commuteNeverRun: Fixture = {
  spec: spec("commute", "Commute", "Door to desk, both directions", "private", 120_000, ["transit__next_departures"]),
  snapshot: undefined,
};

export const ALL_FIXTURES: readonly Fixture[] = [weeklyFitness, airAndSky, today, pantryBroken, commuteNeverRun];
