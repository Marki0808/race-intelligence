import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { analyzeGpxRoute, parseGpxText } from "./gpxAnalysis.ts";
import { createIstria110kAnchorEvidenceFixture } from "./istria110kAnchorEvidence.ts";
import {
  matchRouteAnchors,
  routeAnchorGeometryFromAnalysis,
} from "./routeAnchorMatching.ts";
import { istria110kRaceRecord } from "./istria110kData.ts";

test("Istria fixture retains only repository-backed current-edition context and no guessed position", () => {
  const fixture = createIstria110kAnchorEvidenceFixture();
  assert.equal(fixture.context.raceId, istria110kRaceRecord.race.id);
  assert.equal(fixture.context.editionYear, 2027);
  assert.deepEqual(fixture.context.locations.map(({ name, type }) => [name, type]), [
    ["Buzet", "START"],
    ["Umag", "FINISH"],
    ["Buzet", "AID_STATION"],
    ["Livade", "AID_STATION"],
  ]);
  assert.ok(fixture.evidence.every((entry) =>
    entry.provenance === "official"
    && entry.sourceId !== null
    && fixture.context.sourceIds.includes(entry.sourceId)
    && entry.sourceEditionYear === null
    && entry.coordinateFact === undefined
    && entry.routeKmFact === undefined
    && entry.positionFact === undefined));
  assert.equal(
    istria110kRaceRecord.edition.information.aidStations.knownStations.value
      .every((station) => station.distanceKm.availability === "not-found"),
    true,
  );
});

test("current Istria evidence has zero position-safe named anchors until new evidence is added", async () => {
  const xml = await readFile(new URL("../public/ISTRIA_110K_2027.gpx", import.meta.url), "utf8");
  const parsed = parseGpxText(xml);
  const analysis = analyzeGpxRoute(parsed);
  const fixture = createIstria110kAnchorEvidenceFixture();
  const output = matchRouteAnchors({
    ...fixture,
    route: routeAnchorGeometryFromAnalysis("istria-110k-2027-gpx", analysis),
  });

  assert.equal(output.results.length, 4);
  assert.ok(output.results.every((entry) => entry.state === "context-only"));
  assert.ok(output.dataset.anchors.every((anchor) => anchor.position.type === "UNPOSITIONED"
    && anchor.positionConfidence === "context-only"
    && anchor.visitId === null));
  assert.equal(output.dataset.anchors.filter((anchor) => anchor.position.type !== "UNPOSITIONED").length, 0);
  const positionSafeNamedAnchors = output.dataset.anchors.filter((anchor) => anchor.type === "NAMED_LOCATION"
    && (anchor.positionConfidence === "exact-direct" || anchor.positionConfidence === "verified-match"));
  const positionSafeAnchors = output.dataset.anchors.filter((anchor) =>
    anchor.positionConfidence === "exact-direct" || anchor.positionConfidence === "verified-match");
  // This is a fixture regression guard, not a product invariant. Update it intentionally
  // when current-edition evidence is added that safely positions a named location.
  assert.equal(positionSafeNamedAnchors.length, 0);
  assert.equal(positionSafeAnchors.length, 0);
});

test("checked-in Istria GPX contains track geometry but no waypoint/route-point evidence", async () => {
  const xml = await readFile(new URL("../public/ISTRIA_110K_2027.gpx", import.meta.url), "utf8");
  assert.equal((xml.match(/<trk>/g) ?? []).length, 1);
  assert.equal((xml.match(/<wpt\b/g) ?? []).length, 0);
  assert.equal((xml.match(/<rtept\b/g) ?? []).length, 0);
  assert.ok((xml.match(/<trkpt\b/g) ?? []).length > 0);
});
