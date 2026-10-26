/**
 * IPTC terms ANR emits (docs/technical-design.md#iptc-standards). The vocabularies
 * themselves are vendored in packages/schemas/iptc/.
 */

const DIGSRCTYPE = "http://cv.iptc.org/newscodes/digitalsourcetype/";

/**
 * Digital source type of a publication: AI-made, or AI-made and then edited by a person.
 * IPTC's compositeWithTrainedAlgorithmicMedia means the reverse (human media edited with
 * generative AI), so an edited publication is compositeSynthetic.
 */
export const DIGITAL_SOURCE_TYPES = {
  ai: {
    uri: `${DIGSRCTYPE}trainedAlgorithmicMedia`,
    schemaOrg: "https://schema.org/TrainedAlgorithmicMediaDigitalSource",
  },
  aiEdited: {
    uri: `${DIGSRCTYPE}compositeSynthetic`,
    schemaOrg: "https://schema.org/CompositeSyntheticDigitalSource",
  },
} as const;

export const digitalSourceType = (editedByPerson: boolean) =>
  editedByPerson ? DIGITAL_SOURCE_TYPES.aiEdited : DIGITAL_SOURCE_TYPES.ai;

const SCHEMES: Record<string, string> = {
  medtop: "http://cv.iptc.org/newscodes/mediatopic/",
  genre: "http://cv.iptc.org/newscodes/genre/",
  digsrctype: DIGSRCTYPE,
  trustindicator: "http://cv.iptc.org/newscodes/trustindicator/",
};

/** Expands a qcode such as `medtop:20001298` to its full IPTC URI. */
export function qcodeToUri(qcode: string): string {
  const [alias, code] = qcode.split(":");
  const base = alias === undefined ? undefined : SCHEMES[alias];
  if (!base || !code) throw new Error(`unknown IPTC qcode ${qcode}`);
  return base + code;
}
