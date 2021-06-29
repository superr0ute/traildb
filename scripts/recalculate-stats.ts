import { TrailDb } from "../src";
import { zFactory } from "../src";

(async () => {
  console.log(`srdb: recalculating stats`);

  const srDb = new TrailDb("./data/db.json", "./data/trails", zFactory, {
    verbose: true,
  });

  for (const trail of srDb.trails) {
    const trailData = trail.getRawRouteData();
    await trail.importTrailData(trailData);
  }

  await srDb.saveIndex();
})();
