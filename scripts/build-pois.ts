import { loadJson } from "../src/common";
import {
  tileToQuadkey,
  pointToTile,
  quadkeyToTile,
  tileToBBOX,
} from "@mapbox/tilebelt";

import turfPointToLineDistance from "@turf/point-to-line-distance";
import * as turfBuffer_ from "@turf/buffer";
import type turfBufferType from "@turf/buffer";
import * as JSONStream from "JSONStream";
import * as fs from "fs";

const POI_ZOOM = 9;
const POI_DATA_PATH = `./data/poi`;
const POI_OUT_PATH = `./dist/poi`;

const turfBuffer = turfBuffer_ as unknown as typeof turfBufferType;

(async () => {
  console.log(`srdb: building pois\n`);

  let poiSchema = loadJson("./data/poi-schema.json").map((poi) => ({
    ...poi,
    ...{
      type: poi.selector.split("[")[0],
      tags: Object.assign(
        {},
        ...[poi.selector.split("]")[0].split("[")[1]].map((tag) => {
          const tagParts = tag.split("=");

          return tagParts.length > 1
            ? { [tagParts[0]]: tagParts[1] }
            : { [tagParts[0]]: true };
        })
      ),
    },
  }));

  let trails = loadJson("./dist/traildb-002.json").features;
  
  let trailPoiTiles = Array.from(
    new Set(
      [
        ...trails.map((trail) => {
          console.log(`calculating ${trail.id} tiles`);
          if (trail.geometry.coordinates.length === 0) return [];

          return turfBuffer(trail.geometry, 10, {
            units: "kilometers",
            steps: 8,
          }).geometry.coordinates[0].map((coord) =>
            tileToQuadkey(pointToTile(coord[0], coord[1], POI_ZOOM))
          );
        }),
      ].flat()
    )
  )
    .map((quadkey) => quadkeyToTile(quadkey))
    .sort((a, b) => {
      if (a[0] > b[0]) return 1;
      else if (a[0] < b[0]) return -1;
      else return a[1] < b[1] ? -1 : 1;
    });

  let log = [];
  let poiTimestamp = null;
  let totalPoiCount = 0;

  for (let i = 0; i < trails.length; i++) {
    let trail = trails[i];

    // if trail is unroutable save a blank feature collection
    if (trail.properties["status"] === "unroutable") {
      console.log(`${trail.id} unroutable. skipping\n`);
      await fs.promises.writeFile(
        `${POI_OUT_PATH}/${trail.id}.json`,
        JSON.stringify(
          {
            type: "FeatureCollection",
            features: [],
          },
          null,
          2
        )
      );
      continue;
    }

    let trailPois = [];

    await Promise.all(
      trailPoiTiles.map(
        (poiTile) =>
          new Promise((res, rej) => {
            const poiTilePath = `${POI_DATA_PATH}/${poiTile[2]}/${poiTile[0]}/${poiTile[1]}.json`;

            // read timestamp from first poi tile found
            if (!poiTimestamp)
              poiTimestamp =
                loadJson(poiTilePath).osm3s.timestamp_osm_date.split("T")[0];

            return fs.createReadStream(poiTilePath).pipe(
              JSONStream.parse(["elements", true])
                .on("data", (el) => {
                  const poiType = poiTypeForElement(el, poiSchema);
                  const feat = elementToFeature(el);
                  const maxDistance =
                    typeof poiType["maxDistance"] === "object"
                      ? poiType["maxDistance"][
                          feat.properties[Object.keys(poiType.tags)[0]]
                        ]
                      : poiType["maxDistance"];
                  const distanceM =
                    turfPointToLineDistance(
                      feat.geometry.coordinates,
                      trail.geometry
                    ) * 1000;

                  if (distanceM <= maxDistance)
                    trailPois.push({
                      ...feat,
                      ...{
                        properties: {
                          ...{
                            "@poi": poiType["name"],
                            "@distance": Math.round(distanceM * 10) / 10,
                          },
                          ...feat.properties,
                        },
                      },
                    });
                })
                .on("end", () => res(true))
            );
          })
      )
    ).then(() => {
      const trailPoiCount = Object.assign(
        {},
        ...poiSchema.map((poi) => ({ [poi["name"]]: 0 }))
      );

      const outputStr = JSON.stringify(
        {
          type: "FeatureCollection",
          features:
            // might as well do the count here? ;-P
            trailPois.map((poi) => {
              trailPoiCount[poi.properties["@poi"]] =
                trailPoiCount[poi.properties["@poi"]] + 1;
              return poi;
            }),
        },
        null,
        2
      );

      const outputSize = Buffer.byteLength(outputStr, "utf8");
      const outputLog = [
        // [trailId] [x] poi [yyy] KiB
        [
          `${trail.id.padEnd(5)} ${`${trailPois.length} poi`.padEnd(8)}`,
          `${Math.round(outputSize / 1024)} KiB`,
        ].join(" "),
        //   [poiCount] [poiName]
        [
          ...Object.entries(trailPoiCount).map(
            ([poiName, poiCount]) =>
              `  ${poiCount.toString().padEnd(4)} ${poiName}`
          ),
        ].join("\n"),
        "",
      ].join("\n");

      totalPoiCount = totalPoiCount + trailPois.length;
      console.log(outputLog);
      log.push(outputLog);

      return fs.promises.writeFile(
        `${POI_OUT_PATH}/${trail.id}.json`,
        outputStr
      );
    });
  }

  fs.writeFileSync(
    "./log.txt",
    [
      `[${poiTimestamp}] [poi] [build] ${trails.length} trails ${totalPoiCount} poi`,
      ...log,
    ].join("\n")
  );
})();

const floatTags = ["ele", "population", "capacity"];

const elementToFeature = (element) => ({
  type: "Feature",
  properties: Object.assign(
    {},
    { "@id": `${element["type"].slice(0, 1)}${element["id"]}` },
    ...["changeset", "timestamp", "version", "uid", "user"].map((meta) => ({
      [`@${meta}`]: element[meta],
    })),
    ...Object.entries(element["tags"]).map(
      ([key, value]: [string, string]) => ({
        [key]: floatTags.includes(key) ? parseFloat(value) : value,
      })
    )
  ),
  geometry: {
    type: "Point",
    coordinates:
      element["type"] === "node"
        ? [element["lon"], element["lat"]]
        : [element["center"]["lon"], element["center"]["lat"]],
  },
});

const poiTypeForElement = (element, poiSchema) => {
  // for each poi in the schema
  for (const currentPoi of poiSchema) {
    for (const [key, val] of Object.entries(currentPoi.tags)) {
      if (key in element["tags"]) {
        // check if element tags match poi tags
        if (
          (typeof val === "boolean" && val === true) ||
          (typeof val === "string" && val.indexOf(element["tags"][key]) !== -1)
        ) {
          return currentPoi;
        }
      }
    }
  }

  return "unknown";
};
