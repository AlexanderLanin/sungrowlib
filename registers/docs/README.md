# Sungrow Communication Protocol Documents

Official Sungrow Modbus communication protocol specifications. These are the primary references for the register catalog (`registers-sungrow.json`).

## Files

| PDF | Text | Version | Covers |
|-----|------|---------|--------|
| `communication-protocol-hybrid-v1.1.11.pdf` | `.txt` | V1.1.11 (2025-11) | SH-RT series hybrid inverters |
| `communication-protocol-string-inverters-v1.1.37.pdf` | `.txt` | V1.1.37 | SG series PV grid-connected string inverters |

The `.txt` files are text extractions from the PDFs, included so that AI tools and search can work with the content without PDF parsing.

## Text Extraction Method

Both PDFs have embedded text (generated from office documents, not scanned). We compared `pdftotext -layout` (Poppler) against `ocrmypdf --force-ocr` (Tesseract OCR on rasterized pages):

| Criterion | pdftotext | ocrmypdf --force-ocr |
|-----------|-----------|----------------------|
| Output size (hybrid) | 107 KB, 1769 lines | 60 KB, 1762 lines |
| Output size (string) | 120 KB | 44 KB |
| Table column alignment | Preserved (whitespace columns) | Lost (no layout preservation) |
| Hex values (`0xFFFF`) | Correct | Misread as `OxFFFF` (zero → letter O) |
| Unicode (`～` fullwidth tilde) | Preserved | Converted to ASCII `~` |
| Special chars (`℃`) | Preserved | Converted to `°C` |
| Address ranges (`5004～5005`) | Correct with original chars | `5004~5005` or `5004 ~ 5005` |
| Data types | All correct | `U32` misread as `032` in one case |
| Row numbering | All correct | `4,` instead of `4.` in one case |
| Speed | Instant | ~30s per PDF (rasterize + OCR) |

**Winner: `pdftotext -layout`.** Since these PDFs have embedded text, direct extraction is both faster and more accurate than OCR. OCR adds noise (character misreads) without any benefit. `ocrmypdf --skip-text` (the default mode) correctly detects this and skips all pages, producing an empty sidecar file.

OCR would only be appropriate for scanned PDFs without an embedded text layer.

## Sources

- Hybrid protocol: [bohdan-s/Sungrow-Inverter](https://github.com/bohdan-s/Sungrow-Inverter/tree/main/Modbus%20Information)
- String inverter protocol: [bohdan-s/Sungrow-Inverter](https://github.com/bohdan-s/Sungrow-Inverter/tree/main/Modbus%20Information)

## Usage

These documents define the Modbus register addresses, data types, scaling factors, and value ranges for Sungrow inverters. The register catalog was audited against these specs. When adding or correcting registers, cross-reference against the relevant protocol document.
