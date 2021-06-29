import * as fs from "fs";
import * as du from "du";

import {
  tileToQuadkey,
  pointToTile,
  quadkeyToTile,
  tileToBBOX,
} from "@mapbox/tilebelt";

import { yesterdayDate, loadJson, pause, toMiB } from "../src/common";
import * as turfBuffer_ from "@turf/buffer";
import type turfBufferType from "@turf/buffer";
import { overpass } from "overpass-ts";

const POI_ZOOM = 9;
const POI_PATH = `./data/poi/`;
const OVERPASS_PAUSE = 0;
const OVERPASS_RATE_LIMIT_PAUSE = 10000;
const OVERPASS_RATE_LIMIT_RETRY = 10;

const turfBuffer = turfBuffer_ as unknown as typeof turfBufferType;
(async () => {
  let schema = loadJson("./data/poi-schema.json");
  let updateStartTime = Date.now();
  let yesterday = yesterdayDate();

  // get trail features from dist, filter out unroutable
  let trails = loadJson("./dist/traildb-002.json").features.filter(
    (feat) => feat.geometry.coordinates.length > 0
  );

  // get all poi tiles needed for download, sorted x/y
  const poiTiles = Array.from(
    new Set(
      [
        ...trails.map((trail) => {
          console.log(`calculating ${trail.id} tiles`);

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

  // download tiles synchronously (overpass api rate limit)
  console.log(`srdb: poi update (${trails.length} trails)`);
  console.log(`srdb: downloading ${poiTiles.length} poi tiles`);

  for (let i = 0; i < poiTiles.length; i++) {
    const tile = poiTiles[i];

    const queryPoiTile = async (tile) => {
      const tileStartTime = Date.now();
      const tileBbox = tileToBBOX(tile);

      const poiTileQuery = [
        `[out:json][date:"${yesterday}"][bbox:${[
          tileBbox[1],
          tileBbox[0],
          tileBbox[3],
          tileBbox[2],
        ].join(",")}];`,
        `(\n${schema
          .map((poi) => `  ${poi.selector};`)
          .join("\n")}\n);\nout center meta;`,
      ].join("\n");

      process.stdout.write(
        `srdb: ${i + 1}/${poiTiles.length} poi tile ${tile[2]}/${tile[0]}/${
          tile[1]
        }`
      );

      return overpass(poiTileQuery, {
        rateLimitPause: OVERPASS_RATE_LIMIT_PAUSE,
        rateLimitRetries: OVERPASS_RATE_LIMIT_RETRY,
        endpoint: "https://overpass.kumi.systems/api/interpreter",
      }).then((json) => {
        // sometimes kumi responds with old data on round robbin, ...
        // make sure we got updated data. thanks kumi! <3
        // (no sarcasm, deep gratitude for their public endpoint!)
        const yesterdayTime = new Date(Date.parse(yesterday)).getTime();
        const responseTime = new Date(
          Date.parse(json.osm3s.timestamp_osm_base)
        ).getTime();

        if (responseTime < yesterdayTime) {
          console.log(`\nsrdb: responseTime < yeterdayTime... retrying...`);
          return queryPoiTile(tile);
        } else {
          process.stdout.write(` (${(Date.now() - tileStartTime) / 1000}s)\n`);

          return json;
        }
      });
    };

    await pause(OVERPASS_PAUSE).then(() => {
      return queryPoiTile(tile).then((json) => {
        // make sure parent directory exists
        fs.mkdirSync(`${POI_PATH}/${tile[2]}/${tile[0]}`, {
          recursive: true,
        });

        // write json stringified, including timestamp_osm_date
        fs.writeFileSync(
          `${POI_PATH}/${tile[2]}/${tile[0]}/${tile[1]}.json`,
          JSON.stringify(
            {
              ...{
                osm3s: {
                  ...{ timestamp_osm_date: yesterday },
                  ...json.osm3s,
                },
              },
              elements: json.elements.map((el) => {
                // we don't need node ids
                // keep an empty array for interoperability
                if ("nodes" in el) el["nodes"] = [];
                return el;
              }),
            },
            null,
            2
          )
        );
      });
    });
  }

  console.log(`poi update time ${(Date.now() - updateStartTime) / 1000 / 60}m`);

  const poiTilesSize = await du("./data/poi");

  fs.writeFileSync(
    "./log.txt",
    [
      `[${yesterday.split("T")[0]}] [poi] [update] ${
        poiTiles.length
      } tiles ${toMiB(poiTilesSize)} MiB ${(
        (Date.now() - updateStartTime) /
        1000 /
        60
      ).toFixed(1)} min`,
    ].join("\n")
  );
})();
