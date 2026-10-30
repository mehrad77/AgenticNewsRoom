// Where episode audio, published images and the TTS cache live (D109, D120): the media bucket in
// production, a local directory in development (@anr/storage, D132).
export { localStore, type ObjectStore as MediaStore } from "@anr/storage";
