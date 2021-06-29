import type { OverpassJson } from "overpass-ts";
import type { TrailProperties } from "./trail";
import type { ZFactory } from "z-factory";
import { overpass } from "overpass-ts";
import * as stringify from "json-stringify-pretty-compact";
import * as path from "path";
import * as fs from "fs";

import { Trail } from "./trail";

export type TrailIndex = TrailProperties[];

interface TrailDbOptions {
  verbose?: boolean;
}

export class TrailDb {
  index: TrailIndex;
  zFactory: ZFactory;
  dataPath: string;
  indexPath: string;
  verbose: boolean;
  trails: Trail[] = [];

  constructor(
    indexPath: string,
    dataPath: string,
    zFactory: ZFactory,
    opt: TrailDbOptions = {}
  ) {
    this.verbose = opt.verbose || false;
    this.indexPath = indexPath;
    this.dataPath = dataPath;
    this.zFactory = zFactory;

    this.index = JSON.parse(
      fs.readFileSync(this.indexPath, { encoding: "utf8" })
    );

    this.index.forEach((trail: TrailProperties) => {
      this.trails.push(
        new Trail(this._dataPath(trail["srId"]), trail, this.zFactory, {
          verbose: opt.verbose,
        })
      );
    });

    if (this.verbose) {
      console.log(`srdb: ${this.trails.length} trails in cache`);
    }
  }

  _dataPath(file: string): string {
    return path.join(this.dataPath, `${file}.json`);
  }

  async getChangedElements(date = null): Promise<{
    timestamp_osm_data: string;
    timestamp_osm_base: string;
    elements: string[];
  }> {
    const trailUpdateQueries = this.trails.map((trail) =>
      [
        `(relation(${trail.properties["osmId"].slice(1)}); >>;);`,
        `wr._(newer:"${trail.properties["checkedDate"]}"); out ids qt;`,
      ].join(" ")
    );

    if (this.verbose) console.log(`srdb: sent update elements requrest`);

    return overpass(
      `[out:json][timeout:3404]${
        date ? `[date:"${date}"]` : ""
      }; ${trailUpdateQueries.join("\n")}`
    ).then((json: OverpassJson) => {
      return {
        timestamp_osm_data: date,
        timestamp_osm_base: json.osm3s.timestamp_osm_base,
        elements: [
          ...Array.from(
            new Set(json.elements.map((el) => `${el.type.slice(0, 1)}${el.id}`))
          ),
        ],
      };
    });
  }

  async getTrailElementsMap(): Promise<Map<string, string[]>> {
    const trailIds = this.trails.map((trail) => trail.id);

    // get string id of elements of all trails (ex w123415 r1901235)
    // build a map of element id => trail ID (ex w12345 => ["AT", "CDT"])
    return Promise.all(
      this.trails.map((trail) =>
        trail.getElementIds().then((elementIds) => [trail.id, elementIds])
      )
    ).then((trailElementIds) => {
      const trailElementsMap = new Map();

      trailElementIds.forEach(([trailId, elementIds]) => {
        if (typeof elementIds === "string") elementIds = [elementIds];

        elementIds.forEach((elementId) => {
          const val = trailElementsMap.get(elementId);

          if (typeof val === "undefined")
            trailElementsMap.set(elementId, [trailId]);
          else {
            trailElementsMap.set(elementId, [trailId, ...val]);
          }
        });
      });

      return trailElementsMap;
    });
  }

  async importNewTrails() {
    // synchronously add any new trails
    for (const trail of this.trails) {
      if (!("cachedDate" in trail.properties)) {
        console.log(`srdb: ${trail.id} importing`);
        await trail.update(true);
        await this.saveIndex();
      }
    }
  }

  async saveIndex() {
    return fs.promises.writeFile(
      this.indexPath,
      (stringify as any)(
        this.trails
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .map((trail) => trail.sortedProperties)
      ),
      { encoding: "utf8" }
    );
  }

  getTrailById(trailId: string): Trail | undefined {
    return this.trails.find((trail) => trail.id === trailId);
  }
}
