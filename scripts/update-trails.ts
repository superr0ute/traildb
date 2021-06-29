import { TrailDb } from "../src";
import { zFactory } from "../src";
import * as fs from "fs";
import { pause, yesterdayDate, utcToUnix } from "../src/common";

(async () => {
  const srDb = new TrailDb("./data/db.json", "./data/trails", zFactory, {
    verbose: true,
  });

  // import new trails if any exist
  await srDb.importNewTrails();

  // get current date and find
  const yesterday = yesterdayDate();

  // send overpass request to check for trail element updates
  // meanwhile read trail JSONs to get their list of element ids
  const [
    {
      timestamp_osm_data: checkedDate,
      timestamp_osm_base: dbDate,
      elements: changedEls,
    },
    trailEls,
  ] = await Promise.all([
    srDb.getChangedElements(yesterday),
    srDb.getTrailElementsMap(),
  ]);

  // if the data isn't new nothing to do here
  if (utcToUnix(dbDate) < utcToUnix(yesterday)) {
    console.log(`srdb: no need for trail update`);
    fs.writeFileSync(
      "./log.txt",
      `[${yesterday.split("T")[0]}] [trails] no update`
    );
    return;
  }

  // find trails which belong to any element which has been changed
  // filter out undefined (extraneous member ways/rel not included in route,
  // or way/relation which has just been added)
  const changedTrails = [
    ...Array.from(
      new Set(changedEls.map((changedEl) => trailEls.get(changedEl)).flat())
    ),
  ]
    .filter((trailId) => typeof trailId !== "undefined")
    .map((changedTrailId) => srDb.getTrailById(changedTrailId));

  // build map of routability before trail update for each changed trail
  // { trailId: [routableBefore, routableAfter] }
  const changedTrailsRoutability = Object.assign(
    {},
    ...changedTrails.map((changedTrail) => ({
      [changedTrail.id]: [
        changedTrail.properties["routableDate"] !== "" &&
          changedTrail.properties["checkedDate"] ==
            changedTrail.properties["routableDate"],
      ],
    }))
  );

  // synchronously update trails
  console.log(`srdb: version ${checkedDate}`);
  console.log(`srdb: ${changedTrails.length} changed trails`);

  for (const updateTrail of changedTrails) {
    console.log(`srdb: ${updateTrail.id} updating`);
    await pause(20000).then(() =>
      updateTrail.update(false, checkedDate).then(() => srDb.saveIndex())
    );
  }

  // add routability of each trail after update
  for (const changedTrail of changedTrails) {
    changedTrailsRoutability[changedTrail.id].push(
      changedTrail.properties["routableDate"] !== "" &&
        changedTrail.properties["checkedDate"] ==
          changedTrail.properties["routableDate"]
    );
  }

  // find broken and fixed trails
  const brokenTrails = [];
  const fixedTrails = [];

  for (const changedTrail of changedTrails) {
    const routableBefore = changedTrailsRoutability[changedTrail.id][0];
    const routableAfter = changedTrailsRoutability[changedTrail.id][1];

    if (routableBefore && !routableAfter) brokenTrails.push(changedTrail.id);
    if (!routableBefore && routableAfter) fixedTrails.push(changedTrail.id);
  }

  // build changelog
  const log = [
    [
      `[${checkedDate.split("T")[0]}] [trails]`,
      brokenTrails.length > 0 ? ` (BROKEN: ${brokenTrails.join(" ")})` : "",
      fixedTrails.length > 0 ? ` (FIXED: ${fixedTrails.join(" ")})` : "",
      ` ${
        changedTrails.length > 0
          ? changedTrails.map((trail) => trail.id).join(" ")
          : "no updates"
      }`,
    ].join(""),
  ];

  for (const changedTrail of changedTrails) {
    const elsMeta = await changedTrail.getElementsMeta(changedEls);
    const changedTrailRoutability = changedTrailsRoutability[changedTrail.id];

    log.push(
      [
        changedTrailRoutability[0] && !changedTrailRoutability[1]
          ? "\n** BROKEN **"
          : "\n",
        changedTrail.id,
        changedTrail.properties["srName"],
        changedTrail.properties["osmId"],
        changedTrailRoutability
          .map((isRoutable) => (isRoutable ? "routable" : "unroutable"))
          .join(" -> "),
      ].join(" ")
    );

    for (const elMeta of elsMeta) {
      log.push(
        [
          " ",
          `${elMeta.type.slice(0, 1)}${elMeta.id}`.padEnd(11, " "),
          `v${elMeta.version}`.padEnd(5, " "),
          elMeta.user.padEnd(16, " "),
          `#${elMeta.changeset}`,
        ].join(" ")
      );
    }
  }

  // update trails checked date
  srDb.trails.forEach((trail) => {
    if (trail.id in changedTrailsRoutability) {
      // if updated trail is routable after update, update routableDate
      if (changedTrailsRoutability[trail.id][1])
        trail.updateProperties({
          checkedDate: checkedDate,
          routableDate: checkedDate,
        });
      // if trail has been broken don't update routable date
      else trail.updateProperties({ checkedDate: checkedDate });
    } else if (
      trail.properties["routableDate"] !== "" &&
      trail.properties["checkedDate"] === trail.properties["routableDate"]
    ) {
      // if trail wasn't updated but was routable last time, set routable date to current date
      trail.updateProperties({
        checkedDate: checkedDate,
        routableDate: checkedDate,
      });
    }
    // if trail unroutable just update checkedDate
    else trail.updateProperties({ checkedDate: checkedDate });
  });

  console.log(`srdb: saving index`);
  srDb.saveIndex();

  console.log(`srdb: saving log`);
  const logStr = log.join("\n");
  fs.writeFileSync("./log.txt", logStr);
  console.log(logStr);

  console.log(`srdb: done`);
})();
