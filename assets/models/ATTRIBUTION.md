# 3D model attributions

All models in this directory come from the
[Amazon Berkeley Objects (ABO) dataset](https://amazon-berkeley-objects.s3.us-east-1.amazonaws.com/index.html),
licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

Credit for the data, including all 3d models: **Amazon.com**.
Credit for building the dataset: Matthieu Guillaumin (Amazon.com),
Thomas Dideriksen (Amazon.com), Kenan Deng (Amazon.com),
Himanshu Arora (Amazon.com), Jasmine Collins (UC Berkeley) and
Jitendra Malik (UC Berkeley).

> Collins et al., *ABO: Dataset and Benchmarks for Real-World 3D Object
> Understanding*, CVPR 2022.

## Files

| File | ABO model id | Product |
| --- | --- | --- |
| `lounger-black.glb` | B071173FS8 | AmazonBasics Outdoor Zero Gravity Lounge Folding Chair, Black |
| `lounger-beige.glb` | B0716DKHS1 | AmazonBasics Outdoor Zero Gravity Lounge Folding Chair, Beige |
| `rug-diamond.glb` | B07QHKWJNQ | Rivet Handtufted Diamond-Patterned Cotton and Wool Area Rug, 4' x 6', Cream with Blue and Orange |
| `side-table.glb` | B07B7H9VMM | Rivet Rustic Reclaimed Fir Wood Side End Table, 16.5"W, Natural |
| `lantern.glb` | B07JXZRQHL | Stone & Beam Rustic Faux Wood Finish Lantern with Bulb, 14"H |
| `pouf-boho.glb` | B075X4QMRF | Rivet Modern Upholstered Cube Ottoman Pouf, 20"W, Boho |
| `patio-heater.glb` | B0753P16BL | AmazonBasics Outdoor Pyramid Patio Heater, Black |

## Modifications

The original glTF (GLB) files were optimized for web/VR delivery with
[glTF-Transform](https://gltf-transform.dev/): textures downscaled
(4096 → 1024px, rug 2048px) and recompressed to WebP, meshes quantized
(KHR_mesh_quantization), unused data pruned. Geometry and materials are
otherwise unchanged.
