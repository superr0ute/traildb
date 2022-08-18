import * as fs from "fs";
import * as du from "du";

import { loadJson, toMiB } from "../src/common";

(async () => {
  console.log(`srdb: generate readme`);

  const index = loadJson("./data/db.json");
  const poiSchema = loadJson("./data/poi-schema.json");
  const poiUpdated = loadJson(
    await fs.promises
      .readdir("./data/poi/9")
      .then((xTiles) => `./data/poi/9/${xTiles[0]}`)
      .then((xPath) =>
        fs.promises.readdir(xPath).then((yTiles) => `${xPath}/${yTiles[0]}`)
      )
  ).osm3s.timestamp_osm_date;

  const dataSizes = {
    trails: await du("./data/trails/"),
    elevation: await du("./data/elev/"),
    poi: await du("./data/poi/"),
    dist: await du("./dist/"),
  };

  const statusCount = (status) =>
    `${index.filter((props) => props["status"] === status).length} ${status}`;

  //
  // heading
  //

  let output = [
    `### traildb version ${index[0]["checkedDate"].split("T")[0]}`,
    `- ${index.length} trails (${[
      "unroutable",
      "routable",
      "broken",
      "complete",
    ]
      .map((status) => statusCount(status))
      .join(", ")})`,
    `- ${toMiB(
      Object.values(dataSizes).reduce((a, b) => a + b, 0)
    )}MiB data (${Object.entries(dataSizes)
      .map(([dataName, dataSize]) => `${toMiB(dataSize)}MiB ${dataName}`)
      .join(", ")})`,
    "- trail status: ❌ unroutable ✔️ routable ❌❌ broken ✔️✔️ complete",
    "",
    "",
  ].join("\n");

  //
  // trail table
  //

  const trailHeaders = ["status", "srId", "srName", "srColor", "updated", "poi"];

  output += `| ${trailHeaders.join(" | ")} |\n`;
  output += `|${trailHeaders.map(() => ` --- `).join("|")}|\n`;

  output += index
    .map(
      (properties) =>
        `|${[
          properties["routableDate"] === ""
            ? "❌"
            : properties["routableDate"] === properties["checkedDate"]
            ? properties["sacScalePct"] === 100 &&
              properties["surfacePct"] === 100
              ? "✔️✔️"
              : "✔️"
            : "❌❌",
          `[${properties["srId"]}](https://superroute.org/${properties["srId"]})`,
          [
            properties["srName"],
            `[osm](https://osm.org/relation/${properties["osmId"].slice(1)})`,
            `[wiki](https://wikidata.org/wiki/${properties["wikidataId"]})`,
          ].join(" "),
          properties["srColor"] === "#000000"
            ? ""
            : `![${
                properties["srColor"]
              }](https://via.placeholder.com/14/${properties["srColor"].slice(
                1
              )}/000000?text=+) ${properties["srColor"]}`,
          properties["cachedDate"].split("T")[0] ===
          index[0]["checkedDate"].split("T")[0]
            ? "today"
            : properties["cachedDate"].split("T")[0],
          properties["status"] === "unroutable"
            ? ""
            : fs.existsSync(`./dist/poi/${properties["srId"]}.json`) ? JSON.parse(
                fs.readFileSync(`./dist/poi/${properties["srId"]}.json`, {
                  encoding: "utf8",
                })
              ).features.length : 0,
        ].join("|")}|`
    )
    .join(`\n`);

  //
  // poi schema
  //

  const poiHeaders = ["name", "selector", "maxDistance"];

  output += [
    "",
    "",
    `### poidb version ${poiUpdated.split("T")[0]}`,
    "",
    `| ${poiHeaders.join(" | ")} |`,
    `| ${poiHeaders.map(() => ` --- `).join("|")}|`,
    poiSchema
      .map(
        (poi) =>
          `| ${[
            poi["name"],
            `\`${poi["selector"].replace(/\|/gs, "\\|")}\``,
            typeof poi["maxDistance"] === "object"
              ? Object.entries(poi["maxDistance"])
                  .map(([value, maxDistance]) => `${value}: ${maxDistance}`)
                  .join(", ")
              : poi["maxDistance"],
          ].join(" | ")} |`
      )
      .join("\n"),
    "",
  ].join("\n");

  console.log("srdb: saving readme");
  await fs.promises.writeFile("./README.md", output);
})();
