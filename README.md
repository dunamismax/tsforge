# scripts

A collection of reusable Python utilities and tools.

## Tools

### emltpl-to-oft

Convert macOS `.emltpl` email templates to Windows Outlook `.oft` format.

Builds valid OLE2 Compound File Binary (CFB) files from scratch following the [MS-OXMSG](https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxmsg/) specification. Pure Python — no third-party dependencies.

```bash
# Convert all .emltpl files in a directory (output alongside originals)
python3 emltpl-to-oft/emltpl_to_oft.py /path/to/templates/

# Convert to a specific output directory
python3 emltpl-to-oft/emltpl_to_oft.py /path/to/templates/ /path/to/output/

# Convert a single file
python3 emltpl-to-oft/emltpl_to_oft.py /path/to/template.emltpl /path/to/output/
```

**Requires:** Python 3.10+

## License

[MIT](LICENSE)
