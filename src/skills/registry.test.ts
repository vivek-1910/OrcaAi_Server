import test from "node:test";
import assert from "node:assert/strict";
import { discoverSkills } from "./registry.js";

const context = {
  waterMode: "marine" as const,
  location: { source: "manual" as const, label: "Mangaluru harbour", latitude: 12.9141, longitude: 74.856 },
  language: "English",
  vessel: { type: "Small boat", name: "", lengthFeet: "" },
  experience: "regular" as const,
  tripTiming: "early-morning" as const,
};

test("fishing window questions activate the safety skill", () => {
  const skills = discoverSkills("Find my best fishing window", {
    ...context,
  });

  assert.equal(skills[0]?.id, "fishing-safety");
});

test("window does not score as the wind condition trigger", () => {
  const skills = discoverSkills("Find my best fishing window", context);

  assert.notEqual(skills[0]?.id, "fishing-conditions");
});
