import { overpass, OverpassJson } from "overpass-ts";
import { OSMRouteData, OSMRouteRelation } from "superroute";
import * as JSONStream from "JSONStream";
import * as stringify from "json-stringify-pretty-compact";
import * as zfactory from "z-factory";
import * as fs from "fs";

export type TrailStatus = "unroutable" | "routable" | "broken" | "complete";

export interface TrailProperties {
  // required properties to add new trail
  srId: string;
  srName: string;
  osmId: string;
  wikidataId: string;

  // dynamically added properties
  status?: string;
  cachedDate: string;
  routableDate: string;
  checkedDate: string;
  length: number;
  ascent: number;
  descent: number;
}

interface TrailOptions {
  verbose?: boolean;
}

export class Trail {
  properties: TrailProperties;
  zFactory: zfactory.ZFactory;
  dataPath: string;
  verbose: boolean;

  constructor(
    dataPath: string,
    properties: TrailProperties,
    zfactory: zfactory.ZFactory,
    opt: TrailOptions = {}
  ) {
    this.verbose = opt.verbose || false;
    this.properties = properties;
    this.zFactory = zfactory;
    this.dataPath = dataPath;
  }

  async download(date = null) {
    if (this.verbose) console.log(`srdb: ${this.id} downloading`);
    return overpass(
      `[out:json]${date ? `[date:"${date}"]` : ""};
         relation(id:${this.osmRelationId}); out meta;
         >>;
         rel._; out meta;
         way(r); out meta geom;
         node(r); out meta geom;`,
      {
        endpoint: "https://lz4.overpass-api.de/api/interpreter",
        rateLimitPause: 10000,
        rateLimitRetries: 10,
      }
    ).then((json) => {
      json = json as OverpassJson;
      if (this.verbose) console.log(`srdb: ${this.id} downloaded`);

      return json;
    });
  }

  async getRouteData(elev = false): Promise<OSMRouteData> {
    return fs.promises
      .readFile(this.dataPath, { encoding: "utf8" })
      .then((rawRouteData) => {
        const routeDataObj = JSON.parse(rawRouteData);

        const routeData = new OSMRouteData(
          routeDataObj.elements,
          routeDataObj.osm3s.timestamp_osm_base
        );

        if (elev)
          return routeData.addElevation(this.zFactory).then(() => routeData);
        else return routeData;
      });
  }

  async importTrailData(
    trailJson: OverpassJson,
    forceUpdate = false,
    date = null
  ) {
    const routeData = new OSMRouteData(
      trailJson.elements,
      trailJson.osm3s.timestamp_osm_base
    );
    const trail = routeData.get(this.osmId) as OSMRouteRelation;

    if (trail.isRoutable) {
      console.log(`srdb: ${this.id} new data is routable`);
      console.log(`srdb: ${this.id} adding elevation`);

      await routeData.addElevation(this.zFactory, 11);

      this.updateProperties({
        ascent: trail.statistics.ascent,
        cachedDate: date ? date : trailJson.osm3s.timestamp_osm_base,
        routableDate: date ? date : trailJson.osm3s.timestamp_osm_base,
        checkedDate: date ? date : trailJson.osm3s.timestamp_osm_base,
        descent: trail.statistics.descent,
        length: trail.statistics.length,
        sacScalePct: trail.statistics.sacScalePct,
        surfacePct: trail.statistics.surfacePct,
      });

      return this.save(routeData.toJson());
    } else {
      // if old data is routable but new data is not, keep old data
      // update checked date property

      if (this.verbose)
        console.log(`srdb: ${this.id} new data is not routable`);

      if (this.properties["routableDate"] !== "" && !forceUpdate) {
        if (this.verbose)
          console.log(`srdb: ${this.id} keeping routable old data `);

        this.updateProperties({
          checkedDate: date ? date : trailJson.osm3s.timestamp_osm_base,
        });
      } else {
        // if old & new data are unroutable or forceUpdate
        // download and update properties for unroutable trail
        this.updateProperties({
          ascent: -1,
          cachedDate: date ? date : trailJson.osm3s.timestamp_osm_base,
          routableDate: "",
          checkedDate: date ? date : trailJson.osm3s.timestamp_osm_base,
          descent: -1,
          length: trail.statistics.length,
          sacScalePct: trail.statistics.sacScalePct,
          surfacePct: trail.statistics.surfacePct,
        });

        return this.save(routeData.toJson(), date);
      }
    }
  }

  updateProperties(updateObj: { [key: string]: any }) {
    this.properties = Object.assign({}, this.properties, updateObj);
  }

  async save(
    trailJson: OverpassJson | null = null,
    date = null
  ): Promise<void> {
    if (this.verbose) console.log(`srdb: ${this.id} saving`);

    if (trailJson === null)
      trailJson = JSON.parse(
        await fs.promises.readFile(this.dataPath, { encoding: "utf8" })
      );

    return fs.promises.writeFile(
      this.dataPath,
      (stringify as any)({
        osm3s: {
          timestamp_osm_base: date ? date : trailJson.osm3s.timestamp_osm_base,
        },
        elements: trailJson.elements,
      })
    );
  }

  async update(force = false, date = null): Promise<void> {
    return this.download(date).then((trailJson) =>
      this.importTrailData(trailJson, force, date)
    );
  }

  async getElementIds(): Promise<string[]> {
    return new Promise((res, rej) => {
      const elementIds = [];

      fs.createReadStream(this.dataPath).pipe(
        JSONStream.parse(
          ["elements", true],
          (el) => `${el.type.slice(0, 1)}${el.id}`
        )
          .on("data", (elId) => elementIds.push(elId))
          .on("end", () => res(elementIds))
      );
    });
  }

  async getElementsMeta(elements: string[]): Promise<any> {
    const elementIds = elements.map((elStr) => [
      elStr.slice(0, 1) === "w" ? "way" : "relation",
      parseInt(elStr.slice(1)),
    ]);

    const elementsMeta = [];

    return new Promise((res, rej) => {
      const elements = [];

      fs.createReadStream(this.dataPath).pipe(
        JSONStream.parse(["elements", true])
          .on("data", (osmEl) => {
            for (const elementId of elementIds) {
              if (osmEl.id === elementId[1] && osmEl.type === elementId[0])
                elementsMeta.push({
                  type: elementId[0],
                  id: elementId[1],
                  timestamp: osmEl.timestamp,
                  version: osmEl.version,
                  changeset: osmEl.changeset,
                  user: osmEl.user,
                });
            }
          })
          .on("end", () => res(elementsMeta))
      );
    });
  }

  getRawRouteData(): OverpassJson {
    return JSON.parse(fs.readFileSync(this.dataPath, { encoding: "utf8" }));
  }

  getRouteRelation(): OSMRouteRelation {
    const overpassData = this.getRawRouteData();

    const routeData = new OSMRouteData(overpassData.elements);
    const route = routeData.get(this.properties["osmId"]) as OSMRouteRelation;

    return route;
  }

  get id(): string {
    return this.properties["srId"];
  }

  get osmRelationId(): string {
    return this.osmId.slice(1);
  }

  get osmId(): string {
    return this.properties["osmId"];
  }

  get status(): TrailStatus {
    return this.properties["routableDate"] === ""
      ? "unroutable"
      : this.properties["routableDate"] === this.properties["checkedDate"]
      ? this.properties["sacScalePct"] === 100 &&
        this.properties["surfacePct"] === 100
        ? "complete"
        : "routable"
      : "broken";
  }

  get sortedProperties(): TrailProperties {
    return Object.assign(
      {},
      ...[
        "srId",
        "srName",
        "srColor",
        "osmId",
        "wikidataId",
        "status",
        "checkedDate",
        "cachedDate",
        "routableDate",
        "ascent",
        "descent",
        "length",
        "sacScalePct",
        "surfacePct",
      ].map((property) => ({
        [property]:
          property === "status" ? this.status : this.properties[property],
      }))
    );
  }
}
