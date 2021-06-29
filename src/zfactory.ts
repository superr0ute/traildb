import { ZFactory, AWSTileSource, FileTileCache } from "z-factory";

export const zFactory = new ZFactory(
  new AWSTileSource(),
  new FileTileCache("./data/elev")
);
