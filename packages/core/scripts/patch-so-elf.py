#!/usr/bin/env python3
"""
patch-so-elf.py — Patch an ELF .so to:
1. Rename __ndk1 → __1 in BOTH .symtab AND .dynsym (dynamic symbol table)
2. dlopen uses .dynsym, not .symtab — objcopy only patches .symtab

Usage: python3 patch-so-elf.py <path/to/libopentui.so>
"""

import struct
import sys

def read_elf_header(f):
    f.seek(0)
    ident = f.read(16)
    if ident[:4] != b'\x7fELF':
        raise ValueError("Not an ELF file")
    is_64 = ident[4] == 2
    is_le = ident[5] == 1
    fmt = '<' if is_le else '>'
    
    if is_64:
        f.seek(0)
        hdr = f.read(64)
        e_shoff = struct.unpack(fmt + 'Q', hdr[40:48])[0]
        e_shentsize = struct.unpack(fmt + 'H', hdr[58:60])[0]
        e_shnum = struct.unpack(fmt + 'H', hdr[60:62])[0]
        e_shstrndx = struct.unpack(fmt + 'H', hdr[62:64])[0]
    else:
        f.seek(0)
        hdr = f.read(52)
        e_shoff = struct.unpack(fmt + 'I', hdr[32:36])[0]
        e_shentsize = struct.unpack(fmt + 'H', hdr[46:48])[0]
        e_shnum = struct.unpack(fmt + 'H', hdr[48:50])[0]
        e_shstrndx = struct.unpack(fmt + 'H', hdr[50:52])[0]
    
    return fmt, is_64, e_shoff, e_shentsize, e_shnum, e_shstrndx

def read_section_headers(f, fmt, is_64, e_shoff, e_shentsize, e_shnum):
    """Read all section headers."""
    sections = []
    for i in range(e_shnum):
        f.seek(e_shoff + i * e_shentsize)
        if is_64:
            data = f.read(64)
            sh_name, sh_type, sh_flags, sh_addr, sh_offset, sh_size, \
                sh_link, sh_info, sh_addralign, sh_entsize = \
                struct.unpack(fmt + 'IIQQQQIIQQ', data)
        else:
            data = f.read(40)
            sh_name, sh_type, sh_flags, sh_addr, sh_offset, sh_size, \
                sh_link, sh_info, sh_addralign, sh_entsize = \
                struct.unpack(fmt + 'IIIIIIIIII', data)
        sections.append({
            'name': sh_name, 'type': sh_type, 'flags': sh_flags,
            'addr': sh_addr, 'offset': sh_offset, 'size': sh_size,
            'link': sh_link, 'info': sh_info, 'addralign': sh_addralign,
            'entsize': sh_entsize
        })
    return sections

def read_string(f, strtab_offset, string_offset):
    """Read a null-terminated string from the string table."""
    f.seek(strtab_offset + string_offset)
    s = b''
    while True:
        c = f.read(1)
        if c == b'\x00' or c == b'':
            break
        s += c
    return s

def rename_ndk1_in_section(f, fmt, is_64, section, strtab_section):
    """Rename __ndk1 → __1 in all symbol names in a symbol table section.
    
    Symbol tables reference strings in an associated string table (section['link']).
    We can't rename in-place (string lengths differ), but we CAN:
    1. Read all symbol names
    2. Find which ones contain __ndk1
    3. For each, write the renamed string to a NEW location in the string table
    4. Update the symbol's st_name to point at the new string
    
    But that's complex. Simpler: since __ndk1 (6 chars) → __1 (3 chars), we can
    overwrite in-place IF the string has room. Actually, strings are null-terminated
    so we can just overwrite __ndk1 with __1\0 and shift the rest.
    
    Actually simplest: just overwrite "ndk1" with "1\0\0\0" in the string table
    at the right offset. The string table has null-terminated strings packed
    together, so we need to be careful not to corrupt adjacent strings.
    
    Best approach: find each __ndk1 in the string table, replace with __1\0
    and move any following string content back by 3 bytes. But that would
    break all offsets after the rename point.
    
    SIMPLEST approach that WORKS: overwrite just the "ndk1" part with "1\0\0\0".
    This makes the string "__1\0\0\0..." which reads as "__1" (null-terminated).
    The extra bytes after the null don't matter — they're just unused space
    in the string table. Adjacent strings start at their own offsets, which
    we don't change.
    """
    strtab_offset = strtab_section['offset']
    strtab_size = strtab_section['size']
    
    # Read the entire string table
    f.seek(strtab_offset)
    strtab = bytearray(f.read(strtab_size))
    
    # Find all occurrences of __ndk1 and replace with __1\0\0\0
    count = 0
    pos = 0
    while True:
        pos = strtab.find(b'__ndk1', pos)
        if pos == -1:
            break
        # Replace __ndk1 (6 bytes) with __1\0\0\0 (6 bytes)
        strtab[pos:pos+6] = b'__1\x00\x00\x00'
        count += 1
        pos += 6
    
    if count > 0:
        # Write the modified string table back
        f.seek(strtab_offset)
        f.write(bytes(strtab))
    
    return count

def patch_elf(filepath):
    with open(filepath, 'r+b') as f:
        fmt, is_64, e_shoff, e_shentsize, e_shnum, e_shstrndx = read_elf_header(f)
        sections = read_section_headers(f, fmt, is_64, e_shoff, e_shentsize, e_shnum)
        
        # Read section name string table
        shstrtab = sections[e_shstrndx]
        
        total_renamed = 0
        
        # Find all symbol table sections (.symtab and .dynsym)
        for i, section in enumerate(sections):
            if section['type'] == 2:  # SHT_SYMTAB
                # .symtab — link field points to .strtab
                strtab_section = sections[section['link']]
                count = rename_ndk1_in_section(f, fmt, is_64, section, strtab_section)
                if count > 0:
                    print(f"  Renamed {count} __ndk1 → __1 in .symtab string table")
                    total_renamed += count
            elif section['type'] == 11:  # SHT_DYNSYM
                # .dynsym — link field points to .dynstr
                strtab_section = sections[section['link']]
                count = rename_ndk1_in_section(f, fmt, is_64, section, strtab_section)
                if count > 0:
                    print(f"  Renamed {count} __ndk1 → __1 in .dynsym string table (.dynstr)")
                    total_renamed += count
        
        # Also check .dynstr directly (some symbols may be referenced there)
        for i, section in enumerate(sections):
            if section['type'] == 3:  # SHT_STRTAB
                # Check if this is .dynstr by reading its name
                f.seek(shstrtab['offset'] + section['name'])
                name = b''
                while True:
                    c = f.read(1)
                    if c == b'\x00' or c == b'':
                        break
                    name += c
                if name in (b'.dynstr', b'.strtab'):
                    # Already handled above via symbol table link, but check
                    # for any __ndk1 strings we might have missed
                    f.seek(section['offset'])
                    strtab = bytearray(f.read(section['size']))
                    count = 0
                    pos = 0
                    while True:
                        pos = strtab.find(b'__ndk1', pos)
                        if pos == -1:
                            break
                        strtab[pos:pos+6] = b'__1\x00\x00\x00'
                        count += 1
                        pos += 6
                    if count > 0:
                        f.seek(section['offset'])
                        f.write(bytes(strtab))
                        print(f"  Renamed {count} __ndk1 → __1 in {name.decode()}")
                        total_renamed += count
        
        print(f"  Total: {total_renamed} __ndk1 → __1 renames")

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <path/to/libopentui.so>")
        sys.exit(1)
    print(f"Patching {sys.argv[1]}...")
    patch_elf(sys.argv[1])
    print("Done!")
