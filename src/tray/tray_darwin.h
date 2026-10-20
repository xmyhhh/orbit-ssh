#ifndef ORBIT_TRAY_DARWIN_H
#define ORBIT_TRAY_DARWIN_H

// Installs the Orbit SSH item in the macOS menu bar. Safe to call from any
// thread; the work is moved to the main queue because AppKit requires it.
void OrbitTrayCreate(const char *title);

// Removes the menu bar item again.
void OrbitTrayDestroy(void);

#endif /* ORBIT_TRAY_DARWIN_H */
