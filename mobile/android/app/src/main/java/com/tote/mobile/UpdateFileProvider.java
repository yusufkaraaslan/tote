package com.tote.mobile;

/** A distinct component is required: Android identifies providers by class as
 * well as authority. Reusing the existing FileProvider class aliases its state
 * and prevents the package installer from reading the granted update URI. */
public final class UpdateFileProvider extends androidx.core.content.FileProvider {}
