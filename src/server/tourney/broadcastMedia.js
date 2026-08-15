const MEDIA_API_ORIGIN = "https://overfast-api.tekrop.fr";
const MEDIA_REVALIDATE_SECONDS = 24 * 60 * 60;

const normalizeRecords = (records, imageField) =>
  Array.isArray(records)
    ? records
        .filter(
          (record) =>
            typeof record?.name === "string" &&
            typeof record?.[imageField] === "string"
        )
        .map((record) => ({
          key: String(record.key || ""),
          name: record.name,
          imageUrl: record[imageField],
        }))
    : [];

const readCatalog = async (path, imageField) => {
  const response = await fetch(`${MEDIA_API_ORIGIN}${path}`, {
    next: { revalidate: MEDIA_REVALIDATE_SECONDS },
  });
  if (!response.ok) return [];
  return normalizeRecords(await response.json(), imageField);
};

export const readTourneyBroadcastMedia = async () => {
  const [heroes, maps] = await Promise.all([
    readCatalog("/heroes", "portrait").catch(() => []),
    readCatalog("/maps", "screenshot").catch(() => []),
  ]);
  return { heroes, maps };
};
