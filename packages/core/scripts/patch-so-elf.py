#!/usr/bin/env python3
"""
patch-so-elf.py — Patch an ELF .so to remove NEEDED + version info
for Bionic libs, fixing the TLS crash on dlopen.

Fixes the sequential-read bug from the previous version: instead of
zeroing entries in-place (which corrupts the dynamic section by leaving
gaps), this version reads ALL entries first, filters out the ones to
remove, then writes the filtered list back.
"""

import struct
import sys

# ELF constants
DT_NULL = 0
DT_NEEDED = 1
DT_GNU_HASH = 0x6ffffef2
DT_VERSYM = 0x6ffffff0
DT_VERNEED = 0x6ffffffe
DT_VERNEEDNUM = 0x6fffffff

# Bionic libs to remove from NEEDED
REMOVE_LIBS = {b"libc.so", b"libm.so", b"libdl.so"}

# Tags to zero out (version requirements)
ZERO_TAGS = {DT_VERSYM, DT_VERNEED, DT_VERNEEDNUM}

def patch_elf(filepath):
    with open(filepath, 'r+b') as f:
        # Read ELF header
        f.seek(0)
        ident = f.read(16)
        if ident[:4] != b'\x7fELF':
            raise ValueError("Not an ELF file")
        is_64 = ident[4] == 2
        is_le = ident[5] == 1
        fmt = '<' if is_le else '>'
        entry_size = 16 if is_64 else 8

        # Read program headers to find PT_DYNAMIC
        if is_64:
            f.seek(0)
            hdr = f.read(64)
            e_phoff = struct.unpack(fmt + 'Q', hdr[32:40])[0]
            e_phentsize = struct.unpack(fmt + 'H', hdr[54:56])[0]
            e_phnum = struct.unpack(fmt + 'H', hdr[56:58])[0]
        else:
            f.seek(0)
            hdr = f.read(52)
            e_phoff = struct.unpack(fmt + 'I', hdr[28:32])[0]
            e_phentsize = struct.unpack(fmt + 'H', hdr[42:44])[0]
            e_phnum = struct.unpack(fmt + 'H', hdr[44:46])[0]

        dyn_offset = None
        dyn_size = None
        for i in range(e_phnum):
            f.seek(e_phoff + i * e_phentsize)
            if is_64:
                phdr = f.read(56)
                p_type = struct.unpack(fmt + 'I', phdr[0:4])[0]
                p_offset = struct.unpack(fmt + 'Q', phdr[8:16])[0]
                p_filesz = struct.unpack(fmt + 'Q', phdr[32:40])[0]
            else:
                phdr = f.read(32)
                p_type = struct.unpack(fmt + 'I', phdr[0:4])[0]
                p_offset = struct.unpack(fmt + 'I', phdr[4:8])[0]
                p_filesz = struct.unpack(fmt + 'I', phdr[16:20])[0]
            if p_type == 2:  # PT_DYNAMIC
                dyn_offset = p_offset
                dyn_size = p_filesz
                break

        if dyn_offset is None:
            print("  No PT_DYNAMIC found")
            return

        # Read ALL dynamic entries into a list
        entries = []
        num_entries = dyn_size // entry_size
        for i in range(num_entries):
            f.seek(dyn_offset + i * entry_size)
            data = f.read(entry_size)
            if len(data) < entry_size:
                break
            if is_64:
                tag, val = struct.unpack(fmt + 'qQ', data)
            else:
                tag, val = struct.unpack(fmt + 'iI', data)
            entries.append((tag, val))
            if tag == DT_NULL:
                break

        # Find DT_STRTAB
        strtab_offset = None
        for tag, val in entries:
            if tag == 5:  # DT_STRTAB
                strtab_offset = val
                break

        # Build the new entry list
        new_entries = []
        removed_needed = 0
        zeroed_tags = 0

        for tag, val in entries:
            if tag == DT_NULL:
                new_entries.append((tag, val))
                continue

            if tag == DT_NEEDED and strtab_offset is not None:
                # Read the library name
                f.seek(strtab_offset + val)
                name = b''
                while True:
                    c = f.read(1)
                    if c == b'\x00' or c == b'':
                        break
                    name += c
                if name in REMOVE_LIBS:
                    print(f"  Removing NEEDED: {name.decode()}")
                    removed_needed += 1
                    continue  # Skip this entry

            if tag in ZERO_TAGS:
                tag_name = {DT_VERSYM: 'DT_VERSYM', DT_VERNEED: 'DT_VERNEED', DT_VERNEEDNUM: 'DT_VERNEEDNUM'}.get(tag, f'tag {tag}')
                print(f"  Zeroing {tag_name}")
                zeroed_tags += 1
                continue  # Skip this entry

            new_entries.append((tag, val))

        # Write the new entries back
        # Pad with DT_NULL entries to fill the original space
        while len(new_entries) < num_entries:
            new_entries.append((DT_NULL, 0))

        for i, (tag, val) in enumerate(new_entries):
            f.seek(dyn_offset + i * entry_size)
            if is_64:
                f.write(struct.pack(fmt + 'qQ', tag, val))
            else:
                f.write(struct.pack(fmt + 'iI', tag, val))

        print(f"  Removed {removed_needed} NEEDED entries")
        print(f"  Zeroed {zeroed_tags} version tags")
        print(f"  Wrote {len(new_entries)} entries ({num_entries} slots)")

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <path/to/libopentui.so>")
        sys.exit(1)
    print(f"Patching {sys.argv[1]}...")
    patch_elf(sys.argv[1])
    print("Done!")
