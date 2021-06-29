import { OSMRouteData, OSMRouteRelation } from "superroute";
import * as stringify from "json-stringify-pretty-compact";
import { simplify } from "../src/common";
import * as fs from "fs";

(async () => {
  console.log(`srdb: building`);

  const dbIndex = JSON.parse(
    fs.readFileSync("./data/db.json", { encoding: "utf8" })
  );

  const fullDb = {
    type: "FeatureCollection",
    features: dbIndex.map((trailProperties) => ({
      ...{
        type: "Feature",
        id: trailProperties["srId"],
        properties: trailProperties,
      },
      ...{
        geometry:
          trailProperties["status"] === "unroutable"
            ? { type: "LineString", coordinates: [] }
            : (
                new OSMRouteData(
                  JSON.parse(
                    fs.readFileSync(
                      `./data/trails/${trailProperties["srId"]}.json`,
                      { encoding: "utf8" }
                    )
                  ).elements
                ).get(trailProperties["osmId"]) as OSMRouteRelation
              ).lineStringFeature.geometry,
      },
    })),
  };

  const simplifiedDb = (tolerance) =>
    Object.assign(
      {},
      {
        ...fullDb,
        ...{
          features: fullDb.features.map((feat) => ({
            ...feat,
            ...{
              geometry: {
                ...feat.geometry,
                ...{
                  coordinates: simplify(
                    feat.geometry.coordinates.map((coord) => [
                      coord[0],
                      coord[1],
                    ]),
                    tolerance,
                    true
                  ),
                },
              },
            },
          })),
        },
      }
    );

  [0.0001, 0.002, 0.005].forEach((tolerance) => {
    fs.writeFileSync(
      `./dist/traildb-${tolerance.toString().split(".")[1]}.json`,
      (stringify as any)(simplifiedDb(tolerance))
    );
  });

  const dbDate = fullDb.features.find(
    (feat) => feat.properties["status"] !== "unroutable"
  ).properties["checkedDate"];
  const statusCount = Object.assign(
    {},
    ...["unroutable", "routable", "broken", "complete"].map((status) => ({
      [status]: fullDb.features.filter(
        (feat) => feat.properties["status"] === status
      ).length,
    }))
  );

  fs.writeFileSync(
    "./log.txt",
    [
      `[${dbDate.split("T")[0]}] [trails] [build] ${Object.entries(statusCount)
        .map(([status, count]) => `${count} ${status}`)
        .join(", ")}`,
    ].join("\n")
  );
})();
