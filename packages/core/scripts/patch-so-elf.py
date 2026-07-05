#!/usr/bin/env python3
"""
patch-so-elf.py — Patch an ELF .so to remove NEEDED + version info
for Bionic libs, fixing the TLS crash on dlopen.

The problem: Bionic's libc.so uses TLS with IE access model. When
Node.js dlopens a .so that has NEEDED: libc.so, the dynamic linker
tries to load libc.so AGAIN → TLS crash.

The fix: remove NEEDED entries for libc/libm/libdl AND zero out the
version requirement tags (DT_VERNEED, DT_VERNEEDNUM, DT_VERSYM) that
reference them. objcopy --remove-section corrupts the ELF by leaving
the dynamic tags pointing at removed sections. This script properly
updates the dynamic section.

Usage: python3 patch-so-elf.py <path/to/libopentui.so>
"""

import struct
import sys

# ELF constants
DT_NEEDED = 1
DT_VERNEED = 0x6ffffffe
DT_VERNEEDNUM = 0x6fffffff
DT_VERSYM = 0x6ffffff0
DT_NULL = 0

# Bionic libs to remove from NEEDED
REMOVE_LIBS = {b"libc.so", b"libm.so", b"libdl.so"}

def read_elf_header(f):
    f.seek(0)
    ident = f.read(16)
    if ident[:4] != b'\x7fELF':
        raise ValueError("Not an ELF file")
    is_64 = ident[4] == 2
    is_le = ident[5] == 1
    
    fmt = '<' if is_le else '>'
    if is_64:
        # ELF64 header
        f.seek(0)
        hdr = f.read(64)
        e_type, e_machine, e_version, e_entry, e_phoff, e_shoff, \
            e_flags, e_ehsize, e_phentsize, e_phnum, e_shentsize, \
            e_shnum, e_shstrndx = struct.unpack(fmt + 'HHIQQQIHHHHHH', hdr[16:64])
    else:
        # ELF32 header
        f.seek(0)
        hdr = f.read(52)
        e_type, e_machine, e_version, e_entry, e_phoff, e_shoff, \
            e_flags, e_ehsize, e_phentsize, e_phnum, e_shentsize, \
            e_shnum, e_shstrndx = struct.unpack(fmt + 'HHIIIIIHHHHHH', hdr[16:52])
    
    return fmt, is_64, e_phoff, e_phnum, e_phentsize

def find_dynamic_section(f, fmt, is_64, e_phoff, e_phnum, e_phentsize):
    """Find the PT_DYNAMIC program header and return its file offset + size."""
    for i in range(e_phnum):
        f.seek(e_phoff + i * e_phentsize)
        if is_64:
            phdr = f.read(56)
            p_type, p_flags, p_offset, p_vaddr, p_paddr, p_filesz, p_memsz, p_align = \
                struct.unpack(fmt + 'IIQQQQQQ', phdr)
        else:
            phdr = f.read(32)
            p_type, p_offset, p_vaddr, p_paddr, p_filesz, p_memsz, p_flags, p_align = \
                struct.unpack(fmt + 'IIIIIIII', phdr)
        
        if p_type == 2:  # PT_DYNAMIC
            return p_offset, p_filesz
    
    return None, None

def read_dynamic_entries(f, fmt, is_64, dyn_offset, dyn_size):
    """Read all dynamic entries. Returns list of (tag, value) tuples."""
    entries = []
    entry_size = 16 if is_64 else 8
    
    for off in range(0, dyn_size, entry_size):
        f.seek(dyn_offset + off)
        if is_64:
            data = f.read(16)
            if len(data) < 16:
                break
            tag, value = struct.unpack(fmt + 'qQ', data)
        else:
            data = f.read(8)
            if len(data) < 8:
                break
            tag, value = struct.unpack(fmt + 'iI', data)
        
        if tag == DT_NULL:
            entries.append((tag, value))
            break
        entries.append((tag, value))
    
    return entries

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

def patch_elf(filepath):
    """Patch the ELF file in-place."""
    with open(filepath, 'r+b') as f:
        fmt, is_64, e_phoff, e_phnum, e_phentsize = read_elf_header(f)
        dyn_offset, dyn_size = find_dynamic_section(f, fmt, is_64, e_phoff, e_phnum, e_phentsize)
        
        if dyn_offset is None:
            print("  No PT_DYNAMIC found — nothing to patch")
            return
        
        entries = read_dynamic_entries(f, fmt, is_64, dyn_offset, dyn_size)
        
        # Find DT_STRTAB to read NEEDED library names
        strtab_offset = None
        for tag, value in entries:
            if tag == 5:  # DT_STRTAB
                strtab_offset = value
                break
        
        if strtab_offset is None:
            print("  No DT_STRTAB found — can't read library names")
            return
        
        # Collect NEEDED entries to remove
        needed_to_remove = set()
        for i, (tag, value) in enumerate(entries):
            if tag == DT_NEEDED:
                lib_name = read_string(f, strtab_offset, value)
                if lib_name in REMOVE_LIBS:
                    needed_to_remove.add(i)
                    print(f"  Removing NEEDED: {lib_name.decode()}")
        
        # Write patched entries
        entry_size = 16 if is_64 else 8
        write_count = 0
        
        for i, (tag, value) in enumerate(entries):
            write_off = dyn_offset + i * entry_size
            f.seek(write_off)
            
            if i in needed_to_remove:
                # Zero out this NEEDED entry
                if is_64:
                    f.write(struct.pack(fmt + 'qQ', 0, 0))
                else:
                    f.write(struct.pack(fmt + 'iI', 0, 0))
                write_count += 1
            elif tag == DT_VERNEED:
                # Zero out DT_VERNEED
                print("  Zeroing DT_VERNEED")
                if is_64:
                    f.write(struct.pack(fmt + 'qQ', 0, 0))
                else:
                    f.write(struct.pack(fmt + 'iI', 0, 0))
                write_count += 1
            elif tag == DT_VERNEEDNUM:
                # Zero out DT_VERNEEDNUM
                print("  Zeroing DT_VERNEEDNUM")
                if is_64:
                    f.write(struct.pack(fmt + 'qQ', 0, 0))
                else:
                    f.write(struct.pack(fmt + 'iI', 0, 0))
                write_count += 1
            elif tag == DT_VERSYM:
                # Zero out DT_VERSYM
                print("  Zeroing DT_VERSYM")
                if is_64:
                    f.write(struct.pack(fmt + 'qQ', 0, 0))
                else:
                    f.write(struct.pack(fmt + 'iI', 0, 0))
                write_count += 1
        
        print(f"  Patched {write_count} dynamic entries")
        print(f"  NEEDED entries for libc/libm/libdl removed")
        print(f"  Version requirement tags (VERNEED/VERNEEDNUM/VERSYM) zeroed")

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <path/to/libopentui.so>")
        sys.exit(1)
    
    filepath = sys.argv[1]
    print(f"Patching {filepath}...")
    patch_elf(filepath)
    print("Done!")
